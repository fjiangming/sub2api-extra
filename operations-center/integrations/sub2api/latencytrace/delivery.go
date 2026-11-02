package latencytrace

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

const deliveryBufferLimit = 32768

var deliveryCode = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,64}$`)

type deliveryError struct {
	Code string `json:"code"`
	Type string `json:"type"`
}

type deliveryEnvelope struct {
	Type       string         `json:"type"`
	Object     string         `json:"object"`
	Status     string         `json:"status"`
	Code       string         `json:"code"`
	StopReason *string        `json:"stop_reason"`
	Error      *deliveryError `json:"error"`
	Response   *struct {
		Status string         `json:"status"`
		Error  *deliveryError `json:"error"`
	} `json:"response"`
	Choices []struct {
		FinishReason *string `json:"finish_reason"`
		Delta        struct {
			Content          string            `json:"content"`
			ReasoningContent string            `json:"reasoning_content"`
			ToolCalls        []json.RawMessage `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
}

// Inspect only successfully written bytes. Buffers are bounded and never exported.
type DeliveryObserver struct {
	path, contentType, event, kind, code string
	line, data, body                     []byte
	stream, terminal, errorWritten       bool
	output, dropped, discard, writeError bool
}

func NewDeliveryObserver(path string) *DeliveryObserver { return &DeliveryObserver{path: path} }

func (d *DeliveryObserver) Write(p []byte, contentType string) {
	d.contentType = strings.ToLower(contentType)
	d.stream = strings.Contains(d.contentType, "text/event-stream")
	if !d.stream {
		if len(d.body)+len(p) <= deliveryBufferLimit {
			d.body = append(d.body, p...)
		} else {
			d.dropped = true
			d.body = nil
		}
		return
	}
	for _, value := range p {
		if value != '\n' {
			if len(d.line) < deliveryBufferLimit {
				d.line = append(d.line, value)
			} else {
				d.discard = true
				d.dropped = true
			}
			continue
		}
		line := bytes.TrimSuffix(d.line, []byte{'\r'})
		if len(line) == 0 {
			if !d.discard && len(d.data) > 0 {
				d.inspect(d.data, d.event)
			}
			d.data, d.event, d.discard = d.data[:0], "", false
		} else if bytes.HasPrefix(line, []byte("event:")) {
			d.event = strings.TrimSpace(string(line[6:]))
		} else if bytes.HasPrefix(line, []byte("data:")) && !d.discard {
			part := bytes.TrimPrefix(line[5:], []byte{' '})
			if len(d.data)+len(part)+1 <= deliveryBufferLimit {
				d.data = append(d.data, part...)
				d.data = append(d.data, '\n')
			} else {
				d.discard, d.dropped = true, true
			}
		}
		d.line = d.line[:0]
	}
}

func (d *DeliveryObserver) inspect(data []byte, event string) {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("[DONE]")) {
		if strings.HasSuffix(d.path, "/chat/completions") {
			d.terminal = true
		}
		return
	}
	var row deliveryEnvelope
	if json.Unmarshal(data, &row) != nil {
		d.dropped = true
		if event == "error" {
			d.errorWritten, d.kind = true, "sse_error"
		}
		return
	}
	kind := row.Type
	if kind == "" {
		kind = event
	}
	err := row.Error
	if row.Response != nil && row.Response.Error != nil {
		err = row.Response.Error
	}
	if err != nil || event == "error" || kind == "error" || kind == "response.failed" || kind == "response.incomplete" || row.Status == "failed" || row.Status == "incomplete" {
		d.errorWritten = true
		d.kind = "body_error"
		if d.stream {
			d.kind = "sse_error"
			if strings.HasPrefix(kind, "response.") {
				d.kind = "response_failed"
			}
		}
		if err != nil {
			d.code = err.Code
			if d.code == "" {
				d.code = err.Type
			}
		} else {
			d.code = row.Code
			if d.code == "" && event == "error" {
				d.code = row.Type
			}
		}
		if kind == "response.incomplete" && d.code == "" {
			d.code = "incomplete_response"
		}
	}
	if d.stream {
		if strings.HasSuffix(d.path, "/messages") && kind == "message_stop" ||
			strings.HasSuffix(d.path, "/responses") && kind == "response.completed" && row.Response != nil && row.Response.Status == "completed" {
			d.terminal = true
		}
		if kind == "content_block_delta" || kind == "response.output_text.delta" || kind == "response.function_call_arguments.delta" || kind == "response.reasoning_summary_text.delta" {
			d.output = true
		}
		for _, choice := range row.Choices {
			if choice.Delta.Content != "" || choice.Delta.ReasoningContent != "" || len(choice.Delta.ToolCalls) > 0 {
				d.output = true
			}
		}
	} else if row.Type == "message" && row.StopReason != nil || row.Object == "response" && row.Status == "completed" {
		d.terminal, d.output = true, true
	} else if row.Object == "chat.completion" && len(row.Choices) > 0 {
		complete := true
		for _, choice := range row.Choices {
			complete = complete && choice.FinishReason != nil && *choice.FinishReason != ""
		}
		d.terminal, d.output = complete, true
	}
}

func (d *DeliveryObserver) WriteFailed() { d.writeError = true }

func (d *DeliveryObserver) Finish(status int, written, disconnected, interrupted bool) Attributes {
	if !d.stream && len(d.body) > 0 && !d.dropped {
		d.inspect(d.body, "")
	}
	complete := written && status >= 200 && status < 300 && d.terminal && !d.errorWritten && !d.dropped && !d.writeError && !disconnected && !interrupted
	if written && status >= 400 && !d.writeError {
		d.errorWritten, d.kind = true, "http_error"
	}
	knownProtocol := strings.HasSuffix(d.path, "/messages") || strings.HasSuffix(d.path, "/responses") || strings.HasSuffix(d.path, "/chat/completions")
	if !d.errorWritten {
		if complete {
			d.kind = "complete"
		} else if d.stream && written && knownProtocol && !d.terminal && !d.dropped && !disconnected && !d.discard && len(d.line) == 0 && len(bytes.TrimSpace(d.data)) == 0 {
			// Full observation of a supported downstream stream ending without its required terminator.
			d.kind, d.code = "incomplete_close", "incomplete_response"
		}
	}
	if !deliveryCode.MatchString(d.code) {
		d.code = ""
	}
	terminal, errorWritten, output := d.terminal, d.errorWritten, d.output
	d.body, d.line, d.data = nil, nil, nil
	return Attributes{ResultVersion: 1, WireStatusCode: status, DownstreamComplete: &complete,
		TerminalSeen: &terminal, ErrorWritten: &errorWritten, ClientDisconnected: &disconnected,
		OutputStarted: &output, DeliveryKind: d.kind, ErrorCode: d.code}
}
