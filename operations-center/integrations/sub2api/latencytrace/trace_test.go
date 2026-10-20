package latencytrace

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHTTPStreamingMilestonesAndRetries(t *testing.T) {
	var mu sync.Mutex
	var received []Event
	terminal := make(chan struct{}, 1)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch struct {
			Events []Event `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Error(err)
		}
		mu.Lock()
		received = append(received, batch.Events...)
		mu.Unlock()
		for _, event := range batch.Events {
			if event.Name == "request_end" {
				terminal <- struct{}{}
			}
		}
		w.WriteHeader(200)
	}))
	defer collector.Close()
	exporter, err := NewExporter(collector.URL, strings.Repeat("a", 32), "test-host")
	if err != nil {
		t.Fatal(err)
	}
	defer exporter.Close()
	ctx, trace := Begin(context.Background(), exporter)
	failed, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:1", nil)
	_, attempt1 := BeginAttempt(failed, 246)
	attempt1.Headers(nil, context.DeadlineExceeded)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-ID", "remote-1")
		io.WriteString(w, "data: {\"type\":\"response.created\"}\n\n")
		w.(http.Flusher).Flush()
		io.WriteString(w, "data: {\"type\":\"response.in_progress\"}\n\n")
		io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\r\n\r\n")
	}))
	defer upstream.Close()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, upstream.URL, strings.NewReader("{}"))
	req, attempt2 := BeginAttempt(req, 270)
	resp, err := http.DefaultClient.Do(req)
	attempt2.Headers(resp, err)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body = attempt2.WrapBody(resp.Body)
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || !strings.Contains(string(body), "hello") {
		t.Fatal("body changed", err)
	}
	trace.Record("", "request_end", Attributes{Outcome: "completed"})
	select {
	case <-terminal:
	case <-time.After(3 * time.Second):
		t.Fatal("events were not exported")
	}
	mu.Lock()
	defer mu.Unlock()
	seen := make(map[string]Event)
	for _, event := range received {
		seen[event.AttemptID+":"+event.Name] = event
	}
	for _, name := range []string{"get_conn", "got_conn", "wrote_request", "response_byte", "response_headers", "first_sse", "first_semantic", "first_content", "attempt_end"} {
		if _, ok := seen["2:"+name]; !ok {
			t.Errorf("missing %s", name)
		}
	}
	if seen["1:attempt_end"].Attributes.Outcome != "error" {
		t.Error("failed attempt was lost")
	}
	if seen["2:response_headers"].Attributes.UpstreamRequestID != "remote-1" {
		t.Error("upstream id was lost")
	}
	if seen["2:first_semantic"].Sequence <= seen["2:first_sse"].Sequence {
		t.Error("initial SSE counted as semantic output")
	}
	if seen["2:attempt_end"].Attributes.Outcome != "completed" {
		t.Error("close replaced EOF outcome")
	}
}

func TestExporterFailureIsBoundedAndNonblocking(t *testing.T) {
	exporter, err := NewExporter("http://127.0.0.1:1", strings.Repeat("a", 32), "test-host")
	if err != nil {
		t.Fatal(err)
	}
	defer exporter.Close()
	started := time.Now()
	var group sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for request := 0; request < 1000; request++ {
				_, trace := Begin(context.Background(), exporter)
				for event := 0; event < 10; event++ {
					trace.Record("", "queue_start", Attributes{})
				}
			}
		}()
	}
	group.Wait()
	if time.Since(started) > 3*time.Second {
		t.Error("exporter blocked business work")
	}
	if exporter.Dropped.Load() == 0 {
		t.Error("overflow was not counted")
	}
	if len(exporter.queue) > 4096 {
		t.Error("queue is unbounded")
	}
}

func TestSSEOversizeAndHeartbeatsDoNotInventSemanticOutput(t *testing.T) {
	exporter, _ := NewExporter("http://127.0.0.1:1", strings.Repeat("a", 32), "test-host")
	defer exporter.Close()
	ctx, _ := Begin(context.Background(), exporter)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost", nil)
	_, attempt := BeginAttempt(req, 1)
	body := &observedBody{attempt: attempt}
	body.consume([]byte(": heartbeat\n\ndata: {\"type\":\"response.in_progress\"}\n\n"))
	body.consume([]byte("data: " + strings.Repeat("x", 100000) + "\n\n"))
	if attempt.seen["first_semantic"] {
		t.Error("heartbeat counted as semantic output")
	}
	if len(body.line) > 32768 || len(body.data) > 32768 {
		t.Error("SSE buffer is unbounded")
	}
}
