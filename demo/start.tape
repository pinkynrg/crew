# Regenerate:  vhs demo/start.tape   (run from repo root)
# Real `crew start` session against demo/config.json -> docs/media/crew-start.gif
#
# 16:10 at 1100x688, which is the shape and the size every demo across these
# repos is delivered at. The gif is optimised after recording; the mp4 is the
# recording as vhs made it:
#
#   vhs demo/start.tape
#   ffmpeg -i docs/media/crew-start.gif -vf "fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 /tmp/crew-start.gif -y
#   gifsicle -O3 --lossy=60 --colors 80 /tmp/crew-start.gif -o docs/media/crew-start.gif
#   # poster (a frame with the full graph selector — adjust -ss to taste):
#   ffmpeg -ss 6 -i docs/media/crew-start.mp4 -frames:v 1 -y docs/media/crew-start-poster.png
#
# Framerate 12 is load-bearing rather than cosmetic: vhs captures each frame
# through the browser, and at this size the default rate outruns the capture,
# so the recording comes out playing at half the length the Sleeps ask for.
Output docs/media/crew-start.gif
Output docs/media/crew-start.mp4

Set Shell "bash"
Set FontSize 17
Set Framerate 12
Set Width 1100
Set Height 688
Set Padding 16
Set TypingSpeed 45ms

Hide
Type 'printf %s "{\"servicesDir\":\"demo/projects\",\"editor\":\"vscode\"}" > demo/local.json'
Enter
Type 'crew() { node bin/crew.js --config demo/config.json "$@"; }'
Enter
Type "clear"
Enter
Show

Type "crew start env=prod"
Sleep 500ms
Enter
Sleep 1800ms

# drop a couple of services we're not touching (stay a connected slice)
Right
Sleep 700ms
Space
Sleep 900ms
Right
Sleep 700ms
Space
Sleep 900ms
Down
Sleep 700ms
Space
Sleep 1200ms

# run the picked slice -> live labelled log viewer (end while it's still streaming, no teardown)
Enter
Sleep 3800ms
