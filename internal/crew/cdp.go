package crew

// `crew cdp <url>` — converge a frontend's BROWSER console into crew's log stream, with ZERO
// changes to the frontend project. It launches Chrome pointed at <url> with a remote-debugging
// port, attaches over the DevTools Protocol, and prints every console call, uncaught exception and
// log entry to STDOUT — so when a service's `tasks.debug` runs `crew cdp {local}`, those lines are
// tee'd into that service's log and the read-only agent reads them via `logs` like any other output.
//
// Stdlib only (a tiny ws client below) — no browser-automation framework, honoring the micro-deps
// rule. The console→line mapping is a pure function (formatCDPEvent) exercised black-box via the
// `stdin` mode, so the crew-owned logic is tested without a real browser in CI.

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// Args use crew's positional / key=value idiom (the global parser rejects `--flags`):
//   crew cdp <url>            launch a debug Chrome at <url> and stream its console
//   crew cdp <url> port=9223  use a specific debug port (default 9222)
//   crew cdp <url> attach     attach to an ALREADY-running debug Chrome (don't launch)
//   crew cdp stdin            test seam: format CDP events read from stdin (no browser)
func cmdCdp(flags *Flags, rest []string) {
	var target, port string
	launch := true
	fromStdin := false
	for _, a := range rest {
		switch {
		case a == "stdin":
			fromStdin = true
		case a == "attach":
			launch = false
		case strings.HasPrefix(a, "port="):
			port = a[len("port="):]
		case !strings.HasPrefix(a, "-"):
			target = a
		}
	}
	if port == "" {
		port = "9222"
	}

	// Test / offline seam: read newline-delimited CDP event JSON from stdin and print the same
	// formatted lines the live tap would. Exercises formatCDPEvent without Chrome.
	if fromStdin {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1024*1024), 8*1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			v, err := ParseJSON([]byte(line))
			if err != nil {
				continue
			}
			msg, _ := v.(*OM)
			if out, ok := formatCDPEvent(msg); ok {
				fmt.Println(out)
			}
		}
		return
	}

	if target == "" {
		fail("crew cdp needs a URL — e.g. crew cdp http://localhost:3001")
	}

	var chrome *exec.Cmd
	if launch {
		chrome = launchChrome(target, port)
		defer func() {
			if chrome != nil && chrome.Process != nil {
				_ = chrome.Process.Kill()
			}
		}()
	}

	// Ctrl-C / SIGTERM: kill chrome and exit (crew's runner sends SIGTERM on teardown).
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		if chrome != nil && chrome.Process != nil {
			_ = chrome.Process.Kill()
		}
		os.Exit(0)
	}()

	wsURL := waitForPageWS(port, 15*time.Second)
	if wsURL == "" {
		fail("could not reach Chrome DevTools on port %s — is a debug Chrome running? (crew launches one unless you pass `attach`)", port)
	}
	if err := streamConsole(wsURL); err != nil {
		fail("devtools stream ended: %s", err.Error())
	}
}

// ---- CDP event → one log line (pure, tested via --from-stdin) ----

// formatCDPEvent maps the console/error/log DevTools events to a single printed line, or ok=false
// for events we don't surface. Kept dependency-free and total so it's trivially testable.
func formatCDPEvent(msg *OM) (string, bool) {
	if msg == nil {
		return "", false
	}
	p := msg.GetOM("params")
	switch msg.GetStr("method") {
	case "Runtime.consoleAPICalled":
		typ := p.GetStr("type") // log|error|warning|info|debug|trace…
		if typ == "" {
			typ = "log"
		}
		var parts []string
		if args, ok := p.Get("args").([]any); ok {
			for _, a := range args {
				parts = append(parts, remoteObjectString(a))
			}
		}
		return "console." + typ + ": " + strings.Join(parts, " ") + callSite(p), true
	case "Runtime.exceptionThrown":
		det := p.GetOM("exceptionDetails")
		text := det.GetStr("text")
		if ex := det.GetOM("exception"); ex != nil {
			if d := ex.GetStr("description"); d != "" {
				text = d
			}
		}
		site := ""
		if u := det.GetStr("url"); u != "" {
			site = "  (" + u + lineCol(det) + ")"
		}
		return "uncaught: " + text + site, true
	case "Log.entryAdded":
		e := p.GetOM("entry")
		lvl := e.GetStr("level") // verbose|info|warning|error
		if lvl == "" {
			lvl = "info"
		}
		site := ""
		if u := e.GetStr("url"); u != "" {
			site = "  (" + u + lineCol(e) + ")"
		}
		return "log." + lvl + ": " + e.GetStr("text") + site, true
	}
	return "", false
}

// remoteObjectString renders a CDP RemoteObject argument as a readable token.
func remoteObjectString(a any) string {
	o, ok := a.(*OM)
	if !ok {
		return fmt.Sprint(a)
	}
	if v := o.Get("value"); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
		return compactJSON(v)
	}
	if s := o.GetStr("description"); s != "" { // objects, functions, errors
		return s
	}
	if s := o.GetStr("unserializableValue"); s != "" {
		return s
	}
	if t := o.GetStr("type"); t != "" {
		return t
	}
	return ""
}

func callSite(p *OM) string {
	st := p.GetOM("stackTrace")
	if st == nil {
		return ""
	}
	if frames, ok := st.Get("callFrames").([]any); ok && len(frames) > 0 {
		if f, ok := frames[0].(*OM); ok {
			if u := f.GetStr("url"); u != "" {
				return "  (" + u + lineCol(f) + ")"
			}
		}
	}
	return ""
}

// lineCol reads a 0-based lineNumber (+optional columnNumber) and renders :line[:col] (1-based).
func lineCol(o *OM) string {
	ln, ok := numField(o, "lineNumber")
	if !ok {
		return ""
	}
	s := fmt.Sprintf(":%d", ln+1)
	if col, ok := numField(o, "columnNumber"); ok {
		s += fmt.Sprintf(":%d", col+1)
	}
	return s
}

func numField(o *OM, k string) (int, bool) {
	switch v := o.Get(k).(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	default:
		// crew's ParseJSON yields json.Number for numbers
		if n, ok := o.Get(k).(interface{ Int64() (int64, error) }); ok {
			if i, err := n.Int64(); err == nil {
				return int(i), true
			}
		}
		return 0, false
	}
}

// ---- Chrome launch + DevTools discovery ----

func launchChrome(target, port string) *exec.Cmd {
	bin := chromeBinary()
	if bin == "" {
		fail("no Chrome/Chromium found on PATH — install it, or run a debug Chrome yourself and use: crew cdp %s --no-launch", target)
	}
	profile, _ := os.MkdirTemp("", "crew-cdp-")
	args := []string{
		"--remote-debugging-port=" + port,
		"--user-data-dir=" + profile, // isolated profile: never touches your real Chrome
		"--no-first-run", "--no-default-browser-check",
		target,
	}
	cmd := exec.Command(bin, args...)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard // Chrome's own chatter stays out of the log
	if err := cmd.Start(); err != nil {
		fail("failed to launch Chrome: %s", err.Error())
	}
	return cmd
}

func chromeBinary() string {
	candidates := []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
	}
	for _, c := range candidates {
		if strings.Contains(c, "/") {
			if pathExists(c) {
				return c
			}
			continue
		}
		if p, err := exec.LookPath(c); err == nil {
			return p
		}
	}
	return ""
}

// waitForPageWS polls the DevTools HTTP endpoint until a page target with a websocket URL appears.
func waitForPageWS(port string, timeout time.Duration) string {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ws := pageWS(port); ws != "" {
			return ws
		}
		time.Sleep(200 * time.Millisecond)
	}
	return ""
}

func pageWS(port string) string {
	resp, err := http.Get("http://127.0.0.1:" + port + "/json")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	v, err := ParseJSON(body)
	if err != nil {
		return ""
	}
	list, _ := v.([]any)
	for _, it := range list {
		o, ok := it.(*OM)
		if !ok {
			continue
		}
		if o.GetStr("type") == "page" {
			if ws := o.GetStr("webSocketDebuggerUrl"); ws != "" {
				return ws
			}
		}
	}
	return ""
}

// ---- stream: enable the domains, print events ----

func streamConsole(wsURL string) error {
	c, err := wsDial(wsURL)
	if err != nil {
		return err
	}
	defer c.close()
	id := 0
	enable := func(method string) error {
		id++
		return c.writeText(fmt.Sprintf(`{"id":%d,"method":%q}`, id, method))
	}
	for _, m := range []string{"Runtime.enable", "Log.enable", "Page.enable"} {
		if err := enable(m); err != nil {
			return err
		}
	}
	for {
		data, err := c.readText()
		if err != nil {
			return err
		}
		v, err := ParseJSON([]byte(data))
		if err != nil {
			continue
		}
		if msg, ok := v.(*OM); ok {
			if line, ok := formatCDPEvent(msg); ok {
				fmt.Println(line)
			}
		}
	}
}

// ---- minimal RFC6455 websocket client (localhost, text frames) — stdlib only ----

type wsConn struct {
	conn net.Conn
	r    *bufio.Reader
}

func wsDial(rawURL string) (*wsConn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	host := u.Host
	if !strings.Contains(host, ":") {
		host += ":80"
	}
	conn, err := net.DialTimeout("tcp", host, 5*time.Second)
	if err != nil {
		return nil, err
	}
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	secKey := base64.StdEncoding.EncodeToString(key)
	path := u.RequestURI()
	req := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + secKey + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: "GET"})
	if err != nil {
		conn.Close()
		return nil, err
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		return nil, fmt.Errorf("websocket upgrade failed: %s", resp.Status)
	}
	// (the Sec-WebSocket-Accept hash is not verified — this is a localhost DevTools socket)
	return &wsConn{conn: conn, r: br}, nil
}

func (c *wsConn) close() { _ = c.conn.Close() }

// writeText sends one masked text frame (clients MUST mask, per RFC6455).
func (c *wsConn) writeText(s string) error {
	payload := []byte(s)
	var hdr []byte
	hdr = append(hdr, 0x81) // FIN + opcode text
	n := len(payload)
	switch {
	case n < 126:
		hdr = append(hdr, byte(0x80|n))
	case n < 65536:
		hdr = append(hdr, 0x80|126)
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(n))
		hdr = append(hdr, ext[:]...)
	default:
		hdr = append(hdr, 0x80|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		hdr = append(hdr, ext[:]...)
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	hdr = append(hdr, mask[:]...)
	masked := make([]byte, n)
	for i := 0; i < n; i++ {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := c.conn.Write(hdr); err != nil {
		return err
	}
	_, err := c.conn.Write(masked)
	return err
}

// readText returns the next text message, transparently answering pings and skipping other frames.
func (c *wsConn) readText() (string, error) {
	for {
		var h [2]byte
		if _, err := io.ReadFull(c.r, h[:]); err != nil {
			return "", err
		}
		fin := h[0]&0x80 != 0
		opcode := h[0] & 0x0f
		masked := h[1]&0x80 != 0
		n := int(h[1] & 0x7f)
		switch n {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(c.r, ext[:]); err != nil {
				return "", err
			}
			n = int(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(c.r, ext[:]); err != nil {
				return "", err
			}
			n = int(binary.BigEndian.Uint64(ext[:]))
		}
		var mask [4]byte
		if masked { // servers don't mask, but honor the bit if set
			if _, err := io.ReadFull(c.r, mask[:]); err != nil {
				return "", err
			}
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(c.r, payload); err != nil {
			return "", err
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
		switch opcode {
		case 0x1: // text
			if !fin {
				continue // CDP messages fit one frame; ignore rare fragments
			}
			return string(payload), nil
		case 0x8: // close
			return "", io.EOF
		case 0x9: // ping -> pong
			_ = c.writePong(payload)
		}
	}
}

func (c *wsConn) writePong(payload []byte) error {
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	hdr := []byte{0x8a, byte(0x80 | len(payload))}
	hdr = append(hdr, mask[:]...)
	masked := make([]byte, len(payload))
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := c.conn.Write(hdr); err != nil {
		return err
	}
	_, err := c.conn.Write(masked)
	return err
}
