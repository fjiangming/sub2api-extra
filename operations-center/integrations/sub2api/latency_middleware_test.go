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
	started := make(chan latencytrace.Event, 4)
	ended := make(chan latencytrace.Event, 4)
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
