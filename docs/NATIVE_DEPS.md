# Native dependencies (`sharp` and transformer models)

## Why this matters

Semantic market matching uses `@xenova/transformers`. That package can load **`sharp`** for image-related code paths. If `pnpm` **install scripts** were skipped or `sharp` has no prebuilt binary for your platform, the **first** dynamic import of `@xenova/transformers` during embedding may throw.

Import paths were fixed so **nothing loads transformers until the first embedding call**. Arbitrage detection **falls back** to text-based similarity if semantic similarity throws.

## Fixes by environment

### Local / WSL

```bash
pnpm approve-builds   # if pnpm blocked sharp/esbuild scripts
pnpm rebuild sharp      # or reinstall with scripts enabled
```

### Vercel

Ensure project settings allow dependency install scripts (default on most plans). If build fails on `sharp`, pin a Node version compatible with sharp’s prebuilds (see [sharp installation](https://sharp.pixelplumbing.com/install)).

### Disable semantic matching entirely

No transformers, no `sharp`:

```bash
MUSASHI_DISABLE_SEMANTIC_MATCHING=1
```

Arbitrage uses synonym expansion + keyword overlap only.

## Model download

On first semantic embedding, `Xenova/all-MiniLM-L6-v2` may download from Hugging Face (~22MB). Cold starts on serverless can be slower until the model is cached on the runtime filesystem.
