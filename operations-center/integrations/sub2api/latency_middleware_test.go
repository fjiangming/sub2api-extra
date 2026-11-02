package middleware

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/Wei-Shaw/sub2api/internal/pkg/latencytrace"
	"github.com/gin-gonic/gin"
)

func TestLatencyTraceLiveEventsAndUsageAlias(t *testing.T) {
	started := make(chan latencytrace.Event, 16)
	ended := make(chan latencytrace.Event, 16)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch struct {
			Events []latencytrace.Event `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Error(err)
		}
		for _, event := range batch.Events {
			if event.Name == "request_start" {
				started <- event
			}
			if event.Name == "request_end" {
				ended <- event
			}
		}
	}))
	defer collector.Close()
	t.Setenv("LATENCY_TELEMETRY_URL", collector.URL)
	t.Setenv("LATENCY_TELEMETRY_TOKEN", strings.Repeat("a", 32))
	t.Setenv("LATENCY_RESOURCE_HOST", "test-host")
	router := gin.New()
	router.Use(gin.Recovery(), LatencyTrace(), RequestLogger(), ClientRequestID())
	defer latencytrace.FromEnv().Close()
	release := make(chan struct{})
	router.POST("/v1/responses", func(c *gin.Context) {
		io.Copy(io.Discard, c.Request.Body)
		<-release
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), ctxkey.UserID, int64(42)))
		c.Writer.WriteString("data: {}\n\n")
		c.Writer.Flush()
	})
	router.POST("/v1/panic", func(c *gin.Context) { panic("test") })
	router.POST("/v1/cancelled", func(c *gin.Context) { c.Status(200) })
	router.POST("/v1/messages", func(c *gin.Context) {
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), ctxkey.UserID, int64(42)))
		if c.Query("mode") == "recovered" {
			for i, status := range []int{502, 200} {
				_, attempt := latencytrace.BeginAttempt(c.Request, int64(356+i))
				attempt.Headers(&http.Response{StatusCode: status, Header: http.Header{}}, nil)
				body := attempt.WrapBody(io.NopCloser(strings.NewReader("{}")))
				io.Copy(io.Discard, body)
				body.Close()
			}
		}
		c.Header("Content-Type", "text/event-stream")
		body := "data: {\"type\":\"content_block_delta\"}\n\n"
		switch c.Query("mode") {
		case "recovered":
			body += "data: {\"type\":\"message_stop\"}\n\n"
		case "error":
			body += "data: {\"type\":\"error\",\"error\":{\"type\":\"api_error\"}}\n\n"
		}
		c.Writer.WriteString(body)
		c.Writer.Flush()
	})
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("{}")))
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("start events were not exported while the handler was waiting")
	}
	select {
	case <-done:
		t.Fatal("handler was expected to remain active")
	default:
	}
	close(release)
	<-done
	select {
	case event := <-ended:
		if event.RequestID != recorder.Header().Get("X-Request-ID") || event.Attributes.Outcome != "completed" {
			t.Fatal("root ID or completion was lost", event)
		}
		if event.Attributes.UsageRequestID != "client:"+recorder.Header().Get("X-Client-Request-ID") {
			t.Fatal("usage log alias was not linked", event.Attributes)
		}
		if event.Attributes.UserID != "42" {
			t.Fatal("authenticated user ID was not retained")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("request end was not exported")
	}
	panicked := httptest.NewRecorder()
	router.ServeHTTP(panicked, httptest.NewRequest(http.MethodPost, "/v1/panic", strings.NewReader("{}")))
	if panicked.Code != 500 {
		t.Fatal("instrumentation changed panic recovery")
	}
	select {
	case event := <-ended:
		if event.Attributes.Outcome != "error" || event.Attributes.ErrorCode != "PANIC" || event.Attributes.StatusCode != 500 {
			t.Fatal("panic was reported as success", event.Attributes)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("panic end was not exported")
	}
	for _, mode := range []string{"recovered", "error", "truncated"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/messages?mode="+mode, nil))
		if response.Code != 200 || !strings.Contains(response.Body.String(), "content_block_delta") {
			t.Fatal("downstream bytes or HTTP status changed")
		}
		select {
		case event := <-ended:
			a := event.Attributes
			if a.ResultVersion != 1 || a.WireStatusCode != 200 || a.UserID != "42" {
				t.Fatal("final evidence or root identity lost", a)
			}
			if mode == "recovered" && (!*a.DownstreamComplete || a.UpstreamAttemptCount == nil || *a.UpstreamAttemptCount != 2 || a.Outcome != "completed") {
				t.Fatal("recovery evidence missing", a)
			}
			if mode == "error" && (!*a.ErrorWritten || a.DeliveryKind != "sse_error" || a.Outcome != "error") {
				t.Fatal("HTTP 200 stream failure lost", a)
			}
			if mode == "truncated" && (a.DeliveryKind != "incomplete_close" || *a.ErrorWritten || a.Outcome != "error") {
				t.Fatal("abnormal downstream termination lost", a)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("final response was not exported", mode)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/cancelled", nil).WithContext(ctx))
	select {
	case event := <-ended:
		if event.Attributes.Outcome != "cancelled" {
			t.Fatal("context cancellation was not retained", event.Attributes)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled request end was not exported")
	}
}
