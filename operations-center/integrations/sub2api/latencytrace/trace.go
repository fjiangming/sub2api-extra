package latencytrace

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptrace"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Attributes struct {
	AccountID         string `json:"accountId,omitempty"`
	UserID            string `json:"userId,omitempty"`
	Model             string `json:"model,omitempty"`
	Effort            string `json:"effort,omitempty"`
	Host              string `json:"host,omitempty"`
	UpstreamRequestID string `json:"upstreamRequestId,omitempty"`
	UsageRequestID    string `json:"usageRequestId,omitempty"`
	Bytes             *int64 `json:"bytes,omitempty"`
	Reused            *bool  `json:"reused,omitempty"`
	Protocol          string `json:"protocol,omitempty"`
	StatusCode        int    `json:"statusCode,omitempty"`
	ErrorCode         string `json:"errorCode,omitempty"`
	Outcome           string `json:"outcome,omitempty"`
	DroppedEvents     int    `json:"droppedEvents,omitempty"`
}

type Event struct {
	RequestID  string     `json:"requestId"`
	AttemptID  string     `json:"attemptId,omitempty"`
	Sequence   int        `json:"sequence"`
	Name       string     `json:"name"`
	At         string     `json:"at"`
	ElapsedMS  float64    `json:"elapsedMs"`
	Attributes Attributes `json:"attributes"`
}

type Exporter struct {
	endpoint, token, host string
	queue                 chan Event
	client                *http.Client
	ctx                   context.Context
	cancel                context.CancelFunc
	done                  chan struct{}
	Dropped               atomic.Uint64
}

func NewExporter(endpoint, token, host string) (*Exporter, error) {
	if endpoint == "" || len(token) < 32 || !safeRequestID.MatchString(host) {
		return nil, errors.New("invalid telemetry configuration")
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil || req.URL.Host == "" || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
		return nil, errors.New("invalid telemetry endpoint")
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &Exporter{endpoint: endpoint, token: token, host: host, queue: make(chan Event, 4096),
		client: &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		ctx:    ctx, cancel: cancel, done: make(chan struct{})}
	go e.run()
	return e, nil
}

var defaultOnce sync.Once
var defaultExporter *Exporter

func FromEnv() *Exporter {
	defaultOnce.Do(func() {
		endpoint := os.Getenv("LATENCY_TELEMETRY_URL")
		if endpoint == "" {
			return
		}
		host := os.Getenv("LATENCY_RESOURCE_HOST")
		if host == "" {
			host, _ = os.Hostname()
		}
		var err error
		defaultExporter, err = NewExporter(endpoint, os.Getenv("LATENCY_TELEMETRY_TOKEN"), host)
		if err != nil {
			log.Print("latency telemetry disabled: invalid configuration")
		}
	})
	return defaultExporter
}

func (e *Exporter) run() {
	defer close(e.done)
	timer := time.NewTicker(200 * time.Millisecond)
	defer timer.Stop()
	batch := make([]Event, 0, 64)
	lastReport := time.Now()
	send := func() {
		if len(batch) == 0 {
			return
		}
		body, _ := json.Marshal(struct {
			Type   string  `json:"type"`
			Events []Event `json:"events"`
		}{"events", batch})
		req, err := http.NewRequestWithContext(e.ctx, http.MethodPost, e.endpoint, bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+e.token)
			var resp *http.Response
			resp, err = e.client.Do(req)
			if resp != nil {
				io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
				resp.Body.Close()
				if resp.StatusCode >= 300 {
					err = errors.New("export rejected")
				}
			}
		}
		if err != nil {
			e.Dropped.Add(uint64(len(batch)))
		}
		batch = batch[:0]
	}
	for {
		select {
		case <-e.ctx.Done():
			return
		case row := <-e.queue:
			batch = append(batch, row)
			if len(batch) == 64 {
				send()
			}
		case <-timer.C:
			send()
			if time.Since(lastReport) >= 30*time.Second {
				if count := e.Dropped.Load(); count > 0 {
					log.Printf("latency export dropped_events=%d queue_depth=%d", count, len(e.queue))
				}
				lastReport = time.Now()
			}
		}
	}
}

func (e *Exporter) Close() {
	if e != nil {
		e.cancel()
		<-e.done
	}
}

type traceKey struct{}
type Trace struct {
	ID                          string
	started                     time.Time
	exporter                    *Exporter
	mu                          sync.Mutex
	sequence, attempts, dropped int
}

func Begin(ctx context.Context, exporter *Exporter) (context.Context, *Trace) {
	if exporter == nil {
		return ctx, nil
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return ctx, nil
	}
	t := &Trace{ID: hex.EncodeToString(random[:]), started: time.Now(), exporter: exporter}
	t.Record("", "request_start", Attributes{Host: exporter.host})
	return context.WithValue(ctx, traceKey{}, t), t
}

func FromContext(ctx context.Context) *Trace { t, _ := ctx.Value(traceKey{}).(*Trace); return t }
func Mark(ctx context.Context, name string, attrs Attributes) {
	if t := FromContext(ctx); t != nil {
		t.Record("", name, attrs)
	}
}

func (t *Trace) Record(attempt, name string, attrs Attributes) {
	if t == nil {
		return
	}
	if len(attrs.Model) > 120 {
		attrs.Model = ""
	}
	if len(attrs.Effort) > 24 {
		attrs.Effort = ""
	}
	if attrs.UsageRequestID != "" && !safeRequestID.MatchString(attrs.UsageRequestID) {
		attrs.UsageRequestID = ""
	}
	t.mu.Lock()
	if t.sequence >= 127 && name != "request_end" {
		t.dropped++
		t.mu.Unlock()
		t.exporter.Dropped.Add(1)
		return
	}
	now := time.Now()
	if name == "request_end" {
		attrs.DroppedEvents = t.dropped
	}
	row := Event{t.ID, attempt, t.sequence, name, now.UTC().Format(time.RFC3339Nano), float64(now.Sub(t.started).Microseconds()) / 1000, attrs}
	t.sequence++
	t.mu.Unlock()
	select {
	case t.exporter.queue <- row:
	default:
		t.exporter.Dropped.Add(1)
		t.mu.Lock()
		t.dropped++
		t.mu.Unlock()
	}
}

type Attempt struct {
	trace  *Trace
	id     string
	mu     sync.Mutex
	seen   map[string]bool
	ended  sync.Once
	stream bool
}

var safeRequestID = regexp.MustCompile(`^[a-zA-Z0-9_.:@-]{1,128}$`)

func BeginAttempt(req *http.Request, accountID int64) (*http.Request, *Attempt) {
	if req == nil {
		return req, nil
	}
	t := FromContext(req.Context())
	if t == nil {
		return req, nil
	}
	t.mu.Lock()
	t.attempts++
	attemptID := strconv.Itoa(t.attempts)
	t.mu.Unlock()
	a := &Attempt{trace: t, id: attemptID, seen: make(map[string]bool)}
	attrs := Attributes{}
	if accountID > 0 {
		attrs.AccountID = strconv.FormatInt(accountID, 10)
	}
	if attemptID == "1" {
		t.Record("", "prepare_end", attrs)
	}
	a.emit("attempt_start", attrs)
	attributes := Attributes{}
	if req.ContentLength >= 0 {
		length := req.ContentLength
		attributes.Bytes = &length
	}
	a.emit("rewrite_end", attributes)
	hooks := &httptrace.ClientTrace{
		GetConn:           func(string) { a.emit("get_conn", Attributes{}) },
		GotConn:           func(v httptrace.GotConnInfo) { a.emit("got_conn", Attributes{Reused: &v.Reused}) },
		DNSStart:          func(httptrace.DNSStartInfo) { a.emit("dns_start", Attributes{}) },
		DNSDone:           func(httptrace.DNSDoneInfo) { a.emit("dns_end", Attributes{}) },
		ConnectStart:      func(string, string) { a.emit("tcp_start", Attributes{}) },
		ConnectDone:       func(string, string, error) { a.emit("tcp_end", Attributes{}) },
		TLSHandshakeStart: func() { a.emit("tls_start", Attributes{}) },
		TLSHandshakeDone:  func(tls.ConnectionState, error) { a.emit("tls_end", Attributes{}) },
		WroteRequest: func(v httptrace.WroteRequestInfo) {
			attrs := Attributes{}
			if v.Err != nil {
				attrs.ErrorCode = "WRITE_FAILED"
			}
			a.emit("wrote_request", attrs)
		},
		GotFirstResponseByte: func() { a.emit("response_byte", Attributes{}) },
	}
	return req.WithContext(httptrace.WithClientTrace(req.Context(), hooks)), a
}

func (a *Attempt) emit(name string, attrs Attributes) {
	if a == nil {
		return
	}
	a.mu.Lock()
	if a.seen[name] {
		a.mu.Unlock()
		return
	}
	a.seen[name] = true
	a.mu.Unlock()
	a.trace.Record(a.id, name, attrs)
}

func (a *Attempt) Headers(resp *http.Response, err error) {
	if a == nil {
		return
	}
	if err != nil {
		a.finish("error", "TRANSPORT_ERROR")
		return
	}
	if resp == nil {
		return
	}
	a.stream = strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream")
	requestID := resp.Header.Get("x-request-id")
	if requestID == "" {
		requestID = resp.Header.Get("request-id")
	}
	if !safeRequestID.MatchString(requestID) {
		requestID = ""
	}
	a.emit("response_headers", Attributes{StatusCode: resp.StatusCode, UpstreamRequestID: requestID, Protocol: resp.Proto})
}

func (a *Attempt) finish(outcome, code string) {
	if a != nil {
		a.ended.Do(func() { a.emit("attempt_end", Attributes{Outcome: outcome, ErrorCode: code}) })
	}
}

func (a *Attempt) WrapBody(body io.ReadCloser) io.ReadCloser {
	if a == nil || body == nil {
		return body
	}
	return &observedBody{ReadCloser: body, attempt: a}
}

type observedBody struct {
	io.ReadCloser
	attempt    *Attempt
	line, data []byte
	discard    bool
}

func (b *observedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if b.attempt.stream {
		b.consume(p[:n])
	}
	if err == io.EOF {
		b.attempt.finish("completed", "")
	} else if err != nil {
		b.attempt.finish("error", "READ_FAILED")
	}
	return n, err
}
func (b *observedBody) Close() error {
	err := b.ReadCloser.Close()
	b.attempt.finish("cancelled", "BODY_CLOSED")
	return err
}

// Parse bounded SSE metadata in place, without retaining prompt or response text.
func (b *observedBody) consume(chunk []byte) {
	for _, value := range chunk {
		if value != '\n' {
			if len(b.line) < 32768 {
				b.line = append(b.line, value)
			} else {
				b.discard = true
			}
			continue
		}
		line := bytes.TrimSuffix(b.line, []byte{'\r'})
		if len(line) == 0 {
			if len(b.data) > 0 && !b.discard {
				b.inspect(b.data)
			}
			b.data = b.data[:0]
			b.discard = false
		} else if bytes.HasPrefix(line, []byte("data:")) {
			data := bytes.TrimSpace(line[5:])
			if len(b.data)+len(data) < 32768 {
				b.data = append(b.data, data...)
				b.data = append(b.data, '\n')
			} else {
				b.discard = true
			}
		}
		b.line = b.line[:0]
	}
}

func (b *observedBody) inspect(data []byte) {
	b.attempt.emit("first_sse", Attributes{})
	var event struct {
		Type    string          `json:"type"`
		Delta   json.RawMessage `json:"delta"`
		Choices []struct {
			Delta struct {
				Content   string            `json:"content"`
				Reasoning string            `json:"reasoning_content"`
				Tools     []json.RawMessage `json:"tool_calls"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if json.Unmarshal(data, &event) != nil {
		return
	}
	semantic, content := false, false
	switch event.Type {
	case "response.output_text.delta", "response.function_call_arguments.delta":
		var delta string
		if json.Unmarshal(event.Delta, &delta) == nil && delta != "" {
			semantic = true
			content = true
		}
	case "response.reasoning_text.delta", "response.reasoning_summary_text.delta":
		var delta string
		if json.Unmarshal(event.Delta, &delta) == nil && delta != "" {
			semantic = true
		}
	case "content_block_delta":
		var delta struct {
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
			Partial  string `json:"partial_json"`
		}
		if json.Unmarshal(event.Delta, &delta) == nil {
			content = delta.Text != "" || delta.Partial != ""
			semantic = content || delta.Thinking != ""
		}
	}
	for _, choice := range event.Choices {
		content = content || choice.Delta.Content != "" || len(choice.Delta.Tools) > 0
		semantic = semantic || content || choice.Delta.Reasoning != ""
	}
	if semantic {
		b.attempt.emit("first_semantic", Attributes{})
	}
	if content {
		b.attempt.emit("first_content", Attributes{})
	}
}
