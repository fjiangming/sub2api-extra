package latencytrace

import (
	"strings"
	"testing"
)

func TestDeliveryFinalEvidence(t *testing.T) {
	cases := []struct {
		name, path, contentType, body, kind, code string
		status                                    int
		complete, errorWritten, output            bool
	}{
		{"anthropic", "/v1/messages", "text/event-stream", "data: {\"type\":\"content_block_delta\"}\n\ndata: {\"type\":\"message_stop\"}\n\n", "complete", "", 200, true, false, true},
		{"responses", "/v1/responses", "text/event-stream", "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\n\r\n", "complete", "", 200, true, false, false},
		{"chat", "/v1/chat/completions", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n", "complete", "", 200, true, false, true},
		{"sse error", "/v1/messages", "text/event-stream", "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}\n\n", "sse_error", "overloaded_error", 200, false, true, false},
		{"named error", "/v1/messages", "text/event-stream", "event: error\ndata: {\"type\":\"overloaded_error\"}\n\n", "sse_error", "overloaded_error", 200, false, true, false},
		{"response failed", "/v1/responses", "text/event-stream", "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"rate_limit_exceeded\"}}}\n\n", "response_failed", "rate_limit_exceeded", 200, false, true, false},
		{"response incomplete", "/v1/responses", "text/event-stream", "data: {\"type\":\"response.incomplete\"}\n\n", "response_failed", "incomplete_response", 200, false, true, false},
		{"downstream truncated", "/v1/messages", "text/event-stream", "data: {\"type\":\"content_block_delta\"}\n\n", "incomplete_close", "incomplete_response", 200, false, false, true},
		{"heartbeat only", "/v1/messages", "text/event-stream", ": ping\n\n", "incomplete_close", "incomplete_response", 200, false, false, false},
		{"unsupported stream", "/custom", "text/event-stream", "data: {}\n\n", "", "", 200, false, false, false},
		{"invalid event", "/v1/messages", "text/event-stream", "data: invalid\n\n", "", "", 200, false, false, false},
		{"http failure", "/v1/messages", "application/json", "{\"error\":{\"code\":\"invalid_api_key\"}}", "http_error", "invalid_api_key", 502, false, true, false},
		{"body failure", "/v1/responses", "application/json", "{\"error\":{\"code\":\"invalid_request\"}}", "body_error", "invalid_request", 200, false, true, false},
		{"nonstream message", "/v1/messages", "application/json", "{\"type\":\"message\",\"stop_reason\":\"end_turn\"}", "complete", "", 200, true, false, true},
		{"nonstream response", "/v1/responses", "application/json", "{\"object\":\"response\",\"status\":\"completed\"}", "complete", "", 200, true, false, true},
		{"nonstream chat", "/v1/chat/completions", "application/json", "{\"object\":\"chat.completion\",\"choices\":[{\"finish_reason\":\"stop\"}]}", "complete", "", 200, true, false, true},
		{"200 alone", "/v1/messages", "application/json", "{}", "", "", 200, false, false, false},
		{"error after terminal", "/v1/messages", "text/event-stream", "data: {\"type\":\"message_stop\"}\n\ndata: {\"error\":{\"type\":\"api_error\"}}\n\n", "sse_error", "api_error", 200, false, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			observer := NewDeliveryObserver(tc.path)
			// Splitting every byte also exercises CRLF, UTF-8 and event-boundary framing.
			for _, value := range []byte(tc.body) {
				observer.Write([]byte{value}, tc.contentType)
			}
			result := observer.Finish(tc.status, true, false, false)
			if result.ResultVersion != 1 || result.WireStatusCode != tc.status || result.DeliveryKind != tc.kind || result.ErrorCode != tc.code ||
				*result.DownstreamComplete != tc.complete || *result.ErrorWritten != tc.errorWritten || *result.OutputStarted != tc.output {
				t.Fatalf("unexpected final evidence: %+v", result)
			}
		})
	}
}

func TestDeliveryMissingOrUnobservedBytesCannotProveRecovery(t *testing.T) {
	for _, scenario := range []string{"oversize", "write failure", "disconnect", "panic", "not written", "wrong terminator"} {
		t.Run(scenario, func(t *testing.T) {
			o := NewDeliveryObserver("/v1/messages")
			if scenario == "oversize" {
				o.Write([]byte("data: "+strings.Repeat("x", 100000)+"\n\n"), "text/event-stream")
			}
			end := "data: {\"type\":\"message_stop\"}\n\n"
			if scenario == "wrong terminator" {
				end = "data: [DONE]\n\n"
			}
			o.Write([]byte(end), "text/event-stream")
			if scenario == "write failure" {
				o.WriteFailed()
			}
			r := o.Finish(200, scenario != "not written", scenario == "disconnect", scenario == "panic")
			if *r.DownstreamComplete || r.DeliveryKind == "complete" {
				t.Fatal("incomplete observation became success")
			}
			if len(o.line) > deliveryBufferLimit || len(o.data) > deliveryBufferLimit {
				t.Fatal("unbounded observation")
			}
		})
	}
}
