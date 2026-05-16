# App Resources

Place the following files here before building:

## Required

- `icon.png` — 1024x1024px, app icon (the gold "G" on dark navy background)
- `splash.png` — 2732x2732px, splash screen (centered logo on #0f0f1a background)

## Android Adaptive Icon (optional but recommended)

- `icon-foreground.png` — 432x432px, foreground layer (the "G" with transparent background)
- `icon-background.png` — 432x432px, background layer (solid #0f0f1a or gradient)

## Generation

After placing these files, run:
```bash
npx capacitor-assets generate
```

This auto-generates all required sizes for iOS + Android from the source images.

## Specs

- Icon should have no transparency on iOS (Apple requirement)
- Icon corners are rounded automatically by iOS — don't pre-round
- Splash should be centered content on solid background — safe area for content is ~800x800px center
- Android adaptive icon needs separate foreground/background layers for the parallax effect
