export interface ClawHubSearchResult {
  slug: string
  name: string
  score: number
}

export function parseClawHubSearchResults(stdout: string): ClawHubSearchResult[] {
  const skills: ClawHubSearchResult[] = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\S+)(?:\s+v\S+)?\s{2,}(.+?)\s{2,}\(([0-9.]+)\)/)
    if (match) {
      skills.push({ slug: match[1], name: match[2].trim(), score: parseFloat(match[3]) })
    }
  }
  return skills
}
