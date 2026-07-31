export const markerPrefix = 'GOTUNE_PPROF=';
export const errorMarkerPrefix = 'GOTUNE_PPROF_ERROR=';

export function createAgentSource(
  token: string,
  enableContentionProfiles = false,
  listenAddress = '127.0.0.1:0'
): string {
  return `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"runtime"
	runtimepprof "runtime/pprof"
	"sync"
	"time"
)

func init() {
	${enableContentionProfiles ? 'runtime.SetBlockProfileRate(1)\n\truntime.SetMutexProfileFraction(1)' : '_ = runtime.SetMutexProfileFraction'}
	listener, err := net.Listen("tcp", ${JSON.stringify(listenAddress)})
	if err != nil {
		fmt.Fprintln(os.Stderr, "${errorMarkerPrefix}"+err.Error())
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.Handle("/debug/pprof/heap", pprof.Handler("heap"))
	mux.Handle("/debug/pprof/allocs", pprof.Handler("allocs"))
	mux.Handle("/debug/pprof/goroutine", pprof.Handler("goroutine"))
	mux.Handle("/debug/pprof/block", pprof.Handler("block"))
	mux.Handle("/debug/pprof/mutex", pprof.Handler("mutex"))
	var cpuMu sync.Mutex
	var cpuBuffer bytes.Buffer
	cpuRecording := false
	mux.HandleFunc("/debug/gotune/cpu/start", func(w http.ResponseWriter, _ *http.Request) {
		cpuMu.Lock()
		defer cpuMu.Unlock()
		if cpuRecording {
			http.Error(w, "CPU recording is already running", http.StatusConflict)
			return
		}
		cpuBuffer.Reset()
		if err := runtimepprof.StartCPUProfile(&cpuBuffer); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		cpuRecording = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(\`{"recording":true}\`))
	})
	mux.HandleFunc("/debug/gotune/cpu/stop", func(w http.ResponseWriter, _ *http.Request) {
		cpuMu.Lock()
		defer cpuMu.Unlock()
		if !cpuRecording {
			http.Error(w, "CPU recording is not running", http.StatusConflict)
			return
		}
		runtimepprof.StopCPUProfile()
		cpuRecording = false
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(cpuBuffer.Bytes())
		cpuBuffer.Reset()
	})
	mux.HandleFunc("/debug/gotune/runtime", func(w http.ResponseWriter, _ *http.Request) {
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Timestamp    int64  \`json:"timestamp"\`
			HeapAlloc    uint64 \`json:"heapAlloc"\`
			HeapObjects  uint64 \`json:"heapObjects"\`
			TotalAlloc   uint64 \`json:"totalAlloc"\`
			NumGC        uint32 \`json:"numGC"\`
			PauseTotalNs uint64 \`json:"pauseTotalNs"\`
			Goroutines   int    \`json:"goroutines"\`
		}{
			Timestamp: time.Now().UnixMilli(), HeapAlloc: stats.HeapAlloc,
			HeapObjects: stats.HeapObjects, TotalAlloc: stats.TotalAlloc,
			NumGC: stats.NumGC, PauseTotalNs: stats.PauseTotalNs,
			Goroutines: runtime.NumGoroutine(),
		})
	})
	const token = "${token}"
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	fmt.Fprintln(os.Stderr, "${markerPrefix}http://"+listener.Addr().String()+"/debug/pprof/?token="+token)
	go func() {
		_ = server.Serve(listener)
	}()
}
`;
}
