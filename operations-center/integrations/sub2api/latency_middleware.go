package middleware

import (
	"io"
	"strconv"
	"strings"
	"sync"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/Wei-Shaw/sub2api/internal/pkg/latencytrace"
	"github.com/gin-gonic/gin"
)

func LatencyTrace() gin.HandlerFunc {
	exporter := latencytrace.FromEnv()
	return func(c *gin.Context) {
		if exporter == nil || c.Request == nil || c.Request.Method != "POST" || strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Next()
			return
		}
		ctx, trace := latencytrace.Begin(c.Request.Context(), exporter)
		if trace == nil {
			c.Next()
			return
		}
		c.Request = c.Request.WithContext(ctx)
		c.Request.Header.Set("X-Request-ID", trace.ID)
		c.Header("X-Request-ID", trace.ID)
		if c.Request.Body != nil {
			c.Request.Body = &latencyRequestBody{ReadCloser: c.Request.Body, trace: trace, length: c.Request.ContentLength}
		}
		writer := &latencyResponseWriter{ResponseWriter: c.Writer, trace: trace, delivery: latencytrace.NewDeliveryObserver(c.Request.URL.Path)}
		c.Writer = writer
		defer func() {
			panicValue := recover()
			attrs := latencytrace.Attributes{StatusCode: c.Writer.Status(), Outcome: "completed"}
			if attrs.StatusCode < 100 {
				attrs.StatusCode = 200
			}
			if panicValue != nil {
				attrs.Outcome = "error"
				attrs.ErrorCode = "PANIC"
				if attrs.StatusCode < 400 {
					attrs.StatusCode = 500
				}
			} else if c.Request.Context().Err() != nil {
				attrs.Outcome = "cancelled"
			} else if c.Writer.Status() >= 400 {
				attrs.Outcome = "error"
			}
			result := writer.delivery.Finish(c.Writer.Status(), c.Writer.Written(), c.Request.Context().Err() != nil, panicValue != nil)
			result.StatusCode, result.Outcome = attrs.StatusCode, attrs.Outcome
			if attrs.ErrorCode != "" {
				result.ErrorCode = attrs.ErrorCode
			}
			if *result.ErrorWritten || result.DeliveryKind == "incomplete_close" {
				result.Outcome = "error"
			}
			attrs = result
			if userID, ok := c.Request.Context().Value(ctxkey.UserID).(int64); ok && userID > 0 {
				attrs.UserID = strconv.FormatInt(userID, 10)
			}
			apiKey, ok := GetAPIKeyFromContext(c)
			if !ok || apiKey == nil {
				apiKey, _ = GetOpsFallbackAPIKey(c)
			}
			if apiKey != nil {
				attrs.APIKeyID = strconv.FormatInt(apiKey.ID, 10)
				if apiKey.GroupID != nil {
					attrs.GroupID = strconv.FormatInt(*apiKey.GroupID, 10)
				}
				if apiKey.User != nil {
					attrs.UserID = strconv.FormatInt(apiKey.User.ID, 10)
				}
			}
			if clientID, _ := c.Request.Context().Value(ctxkey.ClientRequestID).(string); strings.TrimSpace(clientID) != "" {
				attrs.UsageRequestID = "client:" + strings.TrimSpace(clientID)
			} else {
				attrs.UsageRequestID = "local:" + trace.ID
			}
			trace.Record("", "request_end", attrs)
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		c.Next()
	}
}

type latencyRequestBody struct {
	io.ReadCloser
	trace        *latencytrace.Trace
	length, read int64
	once         sync.Once
}

func (b *latencyRequestBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.read += int64(n)
	if err == io.EOF || b.length >= 0 && b.read >= b.length {
		b.once.Do(func() { size := b.read; b.trace.Record("", "body_read", latencytrace.Attributes{Bytes: &size}) })
	}
	return n, err
}

type latencyResponseWriter struct {
	gin.ResponseWriter
	trace        *latencytrace.Trace
	delivery     *latencytrace.DeliveryObserver
	write, flush sync.Once
}

func (w *latencyResponseWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	if n > 0 {
		w.write.Do(func() { w.trace.Record("", "downstream_write", latencytrace.Attributes{}) })
		w.delivery.Write(p[:n], w.Header().Get("Content-Type"))
	}
	if err != nil {
		w.delivery.WriteFailed()
	}
	return n, err
}
func (w *latencyResponseWriter) WriteString(s string) (int, error) { return w.Write([]byte(s)) }
func (w *latencyResponseWriter) Flush() {
	w.ResponseWriter.Flush()
	w.flush.Do(func() { w.trace.Record("", "downstream_flush", latencytrace.Attributes{}) })
}
