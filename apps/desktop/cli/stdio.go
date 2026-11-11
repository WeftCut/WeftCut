package main

// The client side: newline-delimited JSON-RPC on stdin and stdout.

import (
	"bufio"
	"bytes"
	"io"
	"sync"
	"time"
)

// readLines sends each non-empty line of r as an evLine, then evEOF when the
// input ends. A line has no length cap: a tool call may carry megabytes.
func readLines(r io.Reader, events chan<- any) {
	reader := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			events <- evLine{line}
		}
		if err != nil {
			events <- evEOF{}
			return
		}
	}
}

// outbox is the one writer of stdout. Messages queue without bound and a
// goroutine of its own drains them, so a client slow to read never stalls the
// loop that keeps the app session alive.
type outbox struct {
	mu     sync.Mutex
	wake   *sync.Cond
	queue  [][]byte
	closed bool
	done   chan struct{}
}

// newOutbox starts the writer. failed is called once if w stops taking
// output, which is the client going away.
func newOutbox(w io.Writer, failed func()) *outbox {
	o := &outbox{done: make(chan struct{})}
	o.wake = sync.NewCond(&o.mu)
	go func() {
		defer close(o.done)
		buffered := bufio.NewWriterSize(w, 64*1024)
		broken := false
		for {
			o.mu.Lock()
			for len(o.queue) == 0 && !o.closed {
				o.wake.Wait()
			}
			batch := o.queue
			o.queue = nil
			closed := o.closed
			o.mu.Unlock()
			if !broken {
				for _, line := range batch {
					_, _ = buffered.Write(line)
					_ = buffered.WriteByte('\n')
				}
				if err := buffered.Flush(); err != nil {
					broken = true
					failed()
				}
			}
			if closed && len(batch) == 0 {
				return
			}
		}
	}()
	return o
}

// push queues one message, which must hold no line break.
func (o *outbox) push(line []byte) {
	o.mu.Lock()
	o.queue = append(o.queue, line)
	o.mu.Unlock()
	o.wake.Signal()
}

// drainWithin closes the outbox and waits for what was queued to be written,
// at most d: a client that stopped reading must not keep the process.
func (o *outbox) drainWithin(d time.Duration) {
	o.mu.Lock()
	o.closed = true
	o.mu.Unlock()
	o.wake.Signal()
	select {
	case <-o.done:
	case <-time.After(d):
	}
}
