// devbox-manager: mgmt · MCL recipe manager
// Copyright (C) 2026  Andrei
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package devbox

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Broker fans out run lifecycle events to Server-Sent Events subscribers.
// Slow or stuck consumers may miss individual events; clients recover through
// the periodic runs polling instead of backpressure.
type Broker struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

func NewBroker() *Broker { return &Broker{subs: make(map[chan []byte]struct{})} }

func (b *Broker) subscribe() chan []byte {
	ch := make(chan []byte, 64)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *Broker) unsubscribe(ch chan []byte) {
	b.mu.Lock()
	delete(b.subs, ch)
	b.mu.Unlock()
}

func (b *Broker) broadcast(event string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	frame := []byte("event: " + event + "\ndata: " + string(data) + "\n\n")
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- frame:
		default:
		}
	}
}

// PublishRunStarted announces a newly created run.
func (b *Broker) PublishRunStarted(run Run) { b.broadcast("run_started", run) }

// PublishRunOutput streams partial output for an in-flight run.
func (b *Broker) PublishRunOutput(id int64, output string) {
	b.broadcast("run_output", map[string]any{"id": id, "output": output})
}

// PublishRunFinished announces the terminal state of a run.
func (b *Broker) PublishRunFinished(run Run) { b.broadcast("run_finished", run) }

// ServeSSE streams run events until the client disconnects. A periodic
// heartbeat keeps intermediaries from closing the idle connection.
func (b *Broker) ServeSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch := b.subscribe()
	defer b.unsubscribe(ch)
	if _, err := fmt.Fprint(w, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case frame := <-ch:
			if _, err := w.Write(frame); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
