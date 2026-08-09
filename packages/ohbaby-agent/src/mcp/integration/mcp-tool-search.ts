export interface McpToolSearchDocument {
  readonly description: string;
  readonly localName: string;
  readonly mcpServer: string;
  readonly mcpToolName: string;
}

export interface McpToolSearchResult {
  readonly name: string;
  readonly score: number;
}

interface IndexedDocument {
  readonly length: number;
  readonly name: string;
  readonly termFrequencies: ReadonlyMap<string, number>;
}

function tokenize(value: string): string[] {
  const normalized = value
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .toLocaleLowerCase("en-US");
  const chunks = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    if (/^\p{Script=Han}+$/u.test(chunk) && chunk.length > 1) {
      for (let index = 0; index < chunk.length - 1; index += 1) {
        tokens.push(chunk.slice(index, index + 2));
      }
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

function termFrequencies(
  tokens: readonly string[],
): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

export class McpToolSearch {
  private readonly documents: readonly IndexedDocument[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageDocumentLength: number;

  constructor(documents: readonly McpToolSearchDocument[]) {
    this.documents = documents.map((document) => {
      const tokens = tokenize(
        `${document.localName} ${document.mcpServer} ${document.mcpToolName} ${document.description}`,
      );
      const frequencies = termFrequencies(tokens);
      for (const term of frequencies.keys()) {
        this.documentFrequency.set(
          term,
          (this.documentFrequency.get(term) ?? 0) + 1,
        );
      }
      return {
        length: tokens.length,
        name: document.localName,
        termFrequencies: frequencies,
      };
    });
    this.averageDocumentLength =
      this.documents.length === 0
        ? 0
        : this.documents.reduce((sum, document) => sum + document.length, 0) /
          this.documents.length;
  }

  search(query: string, limit: number): McpToolSearchResult[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || limit <= 0) {
      return [];
    }
    const exactName = this.documents.find(
      (document) => document.name === query.trim(),
    )?.name;
    const scores = this.documents
      .map((document) => ({
        name: document.name,
        rawScore: this.score(document, terms),
      }))
      .filter((result) => result.rawScore > 0 || result.name === exactName)
      .map((result) => ({
        name: result.name,
        score:
          result.name === exactName
            ? 1
            : result.rawScore / (result.rawScore + 1),
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.name.localeCompare(right.name),
      );
    return scores.slice(0, limit);
  }

  private score(document: IndexedDocument, terms: readonly string[]): number {
    const k1 = 1.2;
    const b = 0.75;
    let score = 0;
    for (const term of terms) {
      const frequency = document.termFrequencies.get(term) ?? 0;
      if (frequency === 0) {
        continue;
      }
      const containingDocuments = this.documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 +
          (this.documents.length - containingDocuments + 0.5) /
            (containingDocuments + 0.5),
      );
      const lengthRatio =
        this.averageDocumentLength === 0
          ? 0
          : document.length / this.averageDocumentLength;
      score +=
        inverseDocumentFrequency *
        ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * lengthRatio)));
    }
    return score;
  }
}
