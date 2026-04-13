/**
 * Text chunking utilities for RAG system
 */
class TextChunker {
  /**
   * Splits documents into chunks for embedding
   * 
   * Args:
   *   chunk_size: Maximum size of each chunk (in characters)
   *   chunk_overlap: Number of characters to overlap between chunks
   */
  constructor(chunkSize = 1000, chunkOverlap = 200) {
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  /** @param {object} [metadata] — when file is .xlsx/.xls, preserve row newlines for Ask Matriya / search. */
  chunkText(text, metadata, chunkSize = null, chunkOverlap = null) {
    /**
     * Split text into chunks
     * 
     * Args:
     *   text: Text to chunk
     *   metadata: Base metadata for all chunks
     *   chunk_size: Override default chunk size
     *   chunk_overlap: Override default chunk overlap
     * 
     * Returns:
     *   List of chunk dictionaries with 'text' and 'metadata'
     */
    if (!text || !text.trim()) {
      return [];
    }

    const size = chunkSize || this.chunkSize;
    const overlap = chunkOverlap || this.chunkOverlap;

    const cleanedText = this._cleanText(text, metadata);

    const paragraphs = this._splitIntoParagraphs(cleanedText, metadata);

    const chunks = [];
    let currentChunk = "";
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      // If adding this paragraph would exceed chunk size
      if (currentChunk.length + paragraph.length + 1 > size && currentChunk) {
        // Save current chunk
        chunks.push({
          text: currentChunk.trim(),
          metadata: {
            ...metadata,
            chunk_index: chunkIndex,
            chunk_size: currentChunk.length
          }
        });
        chunkIndex++;

        // Start new chunk with overlap
        if (overlap > 0 && currentChunk.length > overlap) {
          const overlapText = currentChunk.slice(-overlap);
          currentChunk = overlapText + "\n" + paragraph;
        } else {
          currentChunk = paragraph;
        }
      } else {
        // Add paragraph to current chunk
        if (currentChunk) {
          currentChunk += "\n" + paragraph;
        } else {
          currentChunk = paragraph;
        }
      }
    }

    // Add final chunk
    if (currentChunk.trim()) {
      chunks.push({
        text: currentChunk.trim(),
        metadata: {
          ...metadata,
          chunk_index: chunkIndex,
          chunk_size: currentChunk.length
        }
      });
    }

    // If text is shorter than chunk_size, ensure we have at least one chunk
    if (chunks.length === 0 && text) {
      const fallback = (cleanedText && cleanedText.trim()) || text.trim();
      chunks.push({
        text: fallback,
        metadata: {
          ...metadata,
          chunk_index: 0,
          chunk_size: fallback.length
        }
      });
    }

    return chunks;
  }

  _isSpreadsheet(metadata) {
    const ft = metadata?.file_type;
    if (ft === '.xlsx' || ft === '.xls') return true;
    const fn = String(metadata?.filename || '');
    return /\.xlsx$/i.test(fn) || /\.xls$/i.test(fn);
  }

  _cleanText(text, metadata = null) {
    /**Clean and normalize text. Spreadsheets: keep row breaks; only collapse horizontal whitespace per line.*/
    if (this._isSpreadsheet(metadata)) {
      return text
        .split(/\r?\n/)
        .map((line) => line.replace(/[\t ]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
    }
    let cleaned = text.replace(/\s+/g, ' ');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
  }

  _splitIntoParagraphs(text, metadata = null) {
    /**Split text into paragraphs and sentences*/
    if (this._isSpreadsheet(metadata)) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return [];
      const groups = [];
      let buf = '';
      for (const line of lines) {
        if (line.length > this.chunkSize) {
          if (buf) {
            groups.push(buf);
            buf = '';
          }
          let start = 0;
          while (start < line.length) {
            const end = Math.min(start + this.chunkSize, line.length);
            groups.push(line.slice(start, end));
            start += this.chunkSize - this.chunkOverlap;
            if (start >= line.length) break;
          }
          continue;
        }
        const next = buf ? `${buf}\n${line}` : line;
        if (next.length > this.chunkSize && buf) {
          groups.push(buf);
          buf = line;
        } else {
          buf = next;
        }
      }
      if (buf) groups.push(buf);
      return groups;
    }

    const paragraphs = text.split(/\n\s*\n/);

    const result = [];
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) {
        continue;
      }

      // If paragraph is longer than chunk_size, split by sentences
      if (trimmed.length > this.chunkSize) {
        // Split by sentence endings (Hebrew and English)
        const sentences = trimmed.split(/([.!?]\s+)/);
        // Recombine sentences with their punctuation
        let currentSentence = "";
        for (let i = 0; i < sentences.length; i += 2) {
          if (i < sentences.length) {
            let sentence = sentences[i];
            if (i + 1 < sentences.length) {
              sentence += sentences[i + 1];
            }
            currentSentence += sentence;

            // If accumulated sentences are long enough, add as paragraph
            if (currentSentence.length > this.chunkSize / 2) {
              result.push(currentSentence.trim());
              currentSentence = "";
            }
          }
        }

        if (currentSentence.trim()) {
          result.push(currentSentence.trim());
        }
      } else {
        result.push(trimmed);
      }
    }

    return result;
  }
}

export default TextChunker;
