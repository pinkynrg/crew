# Regenerate:  vhs demo/start.tape   (run from repo root)
# Real `crew start` session against demo/config.json -> docs/media/crew-start.gif
Output docs/media/crew-start.gif

Set Shell "bash"
Set FontSize 16
Set Width 900
Set Height 780
Set Padding 16
Set TypingSpeed 45ms

Hide
Type 'printf %s "{\"projectsDir\":\"demo/projects\"}" > demo/local.json'
Enter
Type 'crew() { node bin/crew.js --config demo/config.json "$@"; }'
Enter
Type "clear"
Enter
Show

Type "crew start env=production"
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
