package main

import (
	"os"

	"github.com/pinkynrg/crew/internal/crew"
)

func main() {
	crew.Main(os.Args[1:])
}
