# Regenerate:  vhs demo/workspace.tape   (run from repo root)
# Real `crew workspace` session against demo/config.json -> docs/media/crew-workspace.gif
# demo/bin/code is a recording-only stand-in for the real VS Code CLI (see that file).
Output docs/media/crew-workspace.gif

Set Shell "bash"
Set FontSize 16
Set Width 900
Set Height 780
Set Padding 16
Set TypingSpeed 45ms

Hide
Type 'printf %s "{\"projectsDir\":\"demo/projects\"}" > demo/local.json'
Enter
Type 'export PATH="$PWD/demo/bin:$PATH"'
Enter
Type 'crew() { node bin/crew.js --config demo/config.json "$@"; }'
Enter
Type "clear"
Enter
Show

Type "crew workspace"
Sleep 500ms
Enter
Sleep 1800ms

# pick the connected slice we want open in one window
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

# open the set as one VS Code workspace
Enter
Sleep 5500ms
