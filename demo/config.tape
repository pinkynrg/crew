# Regenerate:  vhs demo/config.tape   (run from repo root)
# Real `crew config` session against an empty config: add a FRONTEND and a BACKEND straight from
# their folders (crew auto-fills the fields), then create a GUARD. -> docs/media/crew-config.gif
#
# 16:10 at 1100x688, which is the shape and the size every demo across these
# repos is delivered at. The gif is optimised after recording; the mp4 is the
# recording as vhs made it:
#
#   vhs demo/config.tape
#   ffmpeg -i docs/media/crew-config.gif -vf "fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 /tmp/crew-config.gif -y
#   gifsicle -O3 --lossy=60 --colors 80 /tmp/crew-config.gif -o docs/media/crew-config.gif
#
# Framerate 12 is load-bearing rather than cosmetic: vhs captures each frame
# through the browser, and at this size the default rate outruns the capture,
# so the recording comes out playing at half the length the Sleeps ask for.
Output docs/media/crew-config.gif

Set Shell "bash"
Set FontSize 17
Set Framerate 12
Set Width 1100
Set Height 688
Set Padding 16
Set TypingSpeed 42ms

Hide
Type 'printf %s "{\"projectsDir\":\"demo/projects\"}" > demo/local.json'
Enter
Type 'printf %s "{\"version\":2,\"projects\":{}}" > demo/.scratch-config.json'
Enter
Type 'crew() { node bin/crew.js --config demo/.scratch-config.json "$@"; }'
Enter
Type "clear"
Enter
Show

Type "crew config"
Enter
Sleep 1500ms

# ---- 1) a FRONTEND: pick the alerts/ folder -> crew auto-fills type/runner/env/local/start ----
Enter
Sleep 1000ms
Down
Sleep 600ms
Enter
Sleep 900ms
Down
Sleep 500ms
Enter
Sleep 2600ms
# fill its dev match host (keys derived from the folder's .envs)
Down@130ms 8
Sleep 700ms
Enter
Sleep 500ms
Enter
Type "alerts.dev.demo.dev"
Sleep 300ms
Enter
Sleep 500ms
Escape
Sleep 500ms
Type "s"
Sleep 1500ms

# ---- 2) a BACKEND: new project -> pick the payments/ folder -> auto-filled as backend ----
Left
Sleep 400ms
Down
Sleep 400ms
Enter
Sleep 900ms
Down
Sleep 500ms
Enter
Sleep 800ms
Down@100ms 7
Sleep 500ms
Enter
Sleep 2600ms
Type "s"
Sleep 1500ms

# ---- 3) a GUARD: scroll to Guards -> + New guard -> fill it ----
Left
Sleep 400ms
Down
Sleep 300ms
Down
Sleep 400ms
Enter
Sleep 800ms
Enter
Type "vpn"
Sleep 200ms
Enter
Sleep 350ms
Down
Enter
Type "VPN is connected"
Sleep 200ms
Enter
Sleep 350ms
Down
Enter
Type "nc -z vpn.internal 443"
Sleep 200ms
Enter
Sleep 350ms
Down
Enter
Type "connect the VPN first"
Sleep 200ms
Enter
Sleep 500ms
Type "s"
Sleep 2800ms
