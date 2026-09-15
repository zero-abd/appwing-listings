# appwing-listings

The internship listings mirror behind [Appwing](https://appwing.us)'s Open Roles board.

Every 15 minutes, a GitHub Action here does four things:

1. Fetches Simplify's public `Summer2027-Internships` listings file.
2. Reads a slice of the postings for sponsorship barriers, agent-directed text and stated pay.
3. Compacts the result.
4. Commits two files to the `listings-data` branch.

Appwing's Cloudflare Worker reads
`https://raw.githubusercontent.com/zero-abd/appwing-listings/listings-data/listings.json`
every minute with a conditional GET.

## Why this is a separate public repository

Parsing the ~10 MB upstream file needs more CPU than a free Cloudflare Worker's
10 ms per invocation, so the heavy step runs in GitHub Actions. Standard runners
are free on public repositories. Before 2026-09-15 the same job ran inside
Appwing's private repository, where it used up the private-minutes quota.

## Source of truth

The scripts in `.github/scripts/` are **copies** from Appwing's private repository,
where they are tested. Whenever they change there, copy them here too. This repo's
header lists the Appwing commit they were last copied from.

- Scripts last copied from Appwing commit: `2fba5f66`

## Notes

- GitHub disables scheduled workflows in a public repository after 60 days with no
  repository activity. The mirror's own data commits count as activity; if
  upstream ever goes quiet for that long, re-enable the workflow from the Actions tab.
- `sponsorship-scan.json` is the scan cache. Deleting it forces a cold re-read of
  every posting, which takes many runs.
