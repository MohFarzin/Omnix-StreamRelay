# Publishing `ghcr.io/mohfarzin/omnix-streamrelay`

CI builds the egg image and pushes to GitHub Container Registry. A failed run that ends with:

```text
denied: permission_denied: write_package
```

means the image **built**, but GHCR refused the **push**. The Dockerfile is fine.

## Why it happens

`GITHUB_TOKEN` can only push to a package when:

- this repository created the package, or
- the package’s **Manage Actions access** list grants this repo **Write**.

If the first push used a personal PAT (or another account), the package often stays owned by that user and Actions cannot write until you link the repo.

## Fix A — grant Actions access (preferred)

1. Open [omnix-streamrelay package settings](https://github.com/users/MohFarzin/packages/container/omnix-streamrelay/settings).
2. **Manage Actions access** → **Add repository**.
3. Choose `MohFarzin/Omnix-StreamRelay`, role **Write**.
4. Re-run the failed **Docker image** workflow.

Also set the package to **Public** if Wings should pull without a registry login.

## Fix B — PAT secret

1. Create a classic PAT with `write:packages` (and `read:packages`):  
   https://github.com/settings/tokens  
2. Repo → **Settings** → **Secrets and variables** → **Actions** → create `GHCR_PAT`.
3. Re-run the workflow. The login step uses `GHCR_PAT` when that secret exists.

## Local Wings builds

Panel eggs can also use `~omnix-streamrelay:latest` built on the node:

```bash
sudo docker build -t omnix-streamrelay:latest -f pterodactyl/Dockerfile .
```

That path does not need GHCR.
