/**
 * Main RAG service that orchestrates document processing, chunking, and vector storage
 */
import DocumentProcessor from './documentProcessor.js';
import TextChunker from './chunker.js';
import settings from './config.js';
import SupabaseVectorStore from './vectorStoreSupabase.js';
import LLMService from './llmService.js';
import logger from './logger.js';
import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

class RAGService {
  /**Main service for RAG operations*/
  
  constructor() {
    this.documentProcessor = new DocumentProcessor();
    this.chunker = new TextChunker(
      settings.CHUNK_SIZE,
      settings.CHUNK_OVERLAP
    );
    
    // Initialize vector store - Supabase only
    const dbUrl = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
    if (!dbUrl) {
      throw new Error("POSTGRES_URL environment variable is required.");
    }
    this.vectorStore = new SupabaseVectorStore(
      dbUrl,
      settings.COLLECTION_NAME,
      settings.EMBEDDING_MODEL
    );
    
    this.llmService = new LLMService();
  }
  
  async ingestFile(filePath, originalFilename = null) {
    /**
     * Process a file and add it to the vector database
     * 
     * Args:
     *   file_path: Path to the file to ingest
     *   original_filename: Optional original filename to preserve
     * 
     * Returns:
     *   Dictionary with ingestion results
     */
    logger.info(`Starting ingestion for file: ${filePath}`);
    
    // Process document
    const result = await this.documentProcessor.processFile(filePath);
    
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        file_path: filePath
      };
    }
    
    const text = result.text;
    let metadata = result.metadata;
    
    // Override filename with original filename if provided
    if (originalFilename) {
      // Use the original filename as-is (should already be UTF-8)
      // The database (PostgreSQL with JSONB) handles UTF-8 correctly
      metadata = {
        ...metadata,
        filename: originalFilename
      };
    }
    
    if (!text || !text.trim()) {
      return {
        success: false,
        error: 'No text extracted from file',
        file_path: filePath
      };
    }
    
    // Chunk the text
    logger.info("Chunking document into pieces...");
    const chunks = this.chunker.chunkText(text, metadata);
    logger.info(`Created ${chunks.length} chunks`);
    
    if (chunks.length === 0) {
      return {
        success: false,
        error: 'Failed to create chunks from document',
        file_path: filePath
      };
    }
    
    // Extract texts and metadatas for vector store
    const texts = chunks.map(chunk => chunk.text);
    const metadatas = chunks.map(chunk => chunk.metadata);
    const filenameForStore = metadata.filename;

    // Delta hardening: replace existing chunks for this file (idempotent re-ingest)
    try {
      if (filenameForStore) {
        const delResult = await this.vectorStore.deleteDocuments(null, { filename: filenameForStore });
        if (delResult.deleted_count > 0) {
          logger.info(`Delta: removed ${delResult.deleted_count} existing chunks for file ${filenameForStore}`);
        }
      }
    } catch (e) {
      logger.warn(`Delta delete (non-fatal): ${e.message}`);
    }

    // Add to vector store (ON CONFLICT DO UPDATE in DB = idempotent by chunk id)
    try {
      const ids = await this.vectorStore.addDocuments(texts, metadatas);
      logger.info(`Successfully ingested file: ${filePath}`);
      
      return {
        success: true,
        file_path: filePath,
        filename: metadata.filename,
        chunks_count: chunks.length,
        document_ids: ids,
        metadata: metadata
      };
    } catch (e) {
      logger.error(`Error adding to vector store: ${e.message}`);
      return {
        success: false,
        error: `Error adding to vector store: ${e.message}`,
        file_path: filePath
      };
    }
  }
  
  async ingestDirectory(directoryPath) {
    /**
     * Process all supported files in a directory
     * 
     * Args:
     *   directory_path: Path to directory containing files
     * 
     * Returns:
     *   Dictionary with ingestion results for all files
     */
    const { readdir, stat } = await import('fs/promises');
    const { join, extname } = await import('path');
    
    try {
      const files = await readdir(directoryPath, { recursive: true, withFileTypes: true });
      const supportedExtensions = new Set(settings.ALLOWED_EXTENSIONS);
      
      const filePaths = [];
      for (const file of files) {
        if (file.isFile() && supportedExtensions.has(extname(file.name).toLowerCase())) {
          filePaths.push(join(file.path || directoryPath, file.name));
        }
      }
      
      const results = {
        success: true,
        total_files: filePaths.length,
        successful: 0,
        failed: 0,
        files: []
      };
      
      for (const filePath of filePaths) {
        const result = await this.ingestFile(filePath);
        results.files.push(result);
        
        if (result.success) {
          results.successful++;
        } else {
          results.failed++;
        }
      }
      
      results.success = results.failed === 0;
      
      return results;
    } catch (e) {
      return {
        success: false,
        error: `Directory not found or error reading: ${e.message}`,
        total_files: 0,
        successful: 0,
        failed: 0,
        files: []
      };
    }
  }
  
  async search(query, nResults = 5, filterMetadata = null) {
    /**
     * Search for relevant documents with improved ranking
     * 
     * Args:
     *   query: Search query
     *   n_results: Number of results to return
     *   filter_metadata: Optional metadata filters
     * 
     * Returns:
     *   List of search results, sorted by relevance
     */
    // Search with more results initially, then re-rank
    const initialResults = await this.vectorStore.search(query, nResults * 3, filterMetadata);
    
    if (!initialResults || initialResults.length === 0) {
      return [];
    }
    
    // Re-rank results based on multiple factors
    const scoredResults = [];
    const queryLower = query.toLowerCase();
    const queryWords = new Set(queryLower.split(/\s+/).filter(w => w.trim().length > 1).map(w => w.trim()));
    
    // Extract key terms from query (remove common Hebrew question words)
    const questionWords = new Set(['מה', 'מי', 'איפה', 'מתי', 'איך', 'למה', 'של', 'את', 'ה', 'הוא', 'היא', 'הם', 'הן']);
    const keyTerms = Array.from(queryWords).filter(w => !questionWords.has(w));
    
    for (const result of initialResults) {
      let score = 0.0;
      const document = result.document || '';
      const documentLower = document.toLowerCase();
      const distance = result.distance != null ? result.distance : 999;
      
      // Factor 1: Inverse distance (closer = better)
      // Normalize distance to 0-1 scale (assuming max distance ~2.0)
      if (distance < 999) {
        const distanceScore = Math.max(0, 1 - (distance / 2.0));
        score += distanceScore * 0.4; // 40% weight on semantic similarity
      }
      
      // Factor 2: Keyword matching (exact word matches) - improved for Hebrew
      const docWords = new Set(documentLower.split(/\s+/).filter(w => w.trim().length > 1).map(w => w.trim()));
      const wordMatches = Array.from(queryWords).filter(w => docWords.has(w)).length;
      if (queryWords.size > 0) {
        const keywordScore = wordMatches / queryWords.size;
        score += keywordScore * 0.5; // 50% weight on keyword matching (increased)
      }
      
      // Factor 2b: Partial word matches (for Hebrew morphology)
      let partialMatches = 0;
      for (const qWord of queryWords) {
        if (Array.from(docWords).some(docWord => docWord.includes(qWord) || qWord.includes(docWord))) {
          partialMatches++;
        }
      }
      if (queryWords.size > 0) {
        const partialScore = partialMatches / queryWords.size * 0.2;
        score += partialScore;
      }
      
      // Factor 3: Key term matching (important words from query)
      if (keyTerms.length > 0) {
        const keyTermMatches = keyTerms.filter(term => documentLower.includes(term)).length;
        const keyTermScore = keyTermMatches / keyTerms.length;
        score += keyTermScore * 0.15; // 15% weight on key terms
      }
      
      // Factor 4: Query substring in document (exact phrase)
      if (documentLower.includes(queryLower)) {
        score += 0.05; // 5% bonus for exact phrase match
      }
      
      // Factor 5: Numbers and specific values (important for financial queries)
      const queryNumbers = query.match(/\d+[.,]?\d*/g) || [];
      if (queryNumbers.length > 0) {
        const docNumbers = document.match(/\d+[.,]?\d*/g) || [];
        const numberMatches = new Set(queryNumbers).intersection(new Set(docNumbers)).size;
        if (numberMatches > 0) {
          score += 0.1; // 10% bonus for number matches
        }
      }
      
      scoredResults.push({
        ...result,
        relevance_score: score
      });
    }
    
    // Sort by relevance score (highest first)
    scoredResults.sort((a, b) => b.relevance_score - a.relevance_score);
    
    // Return top nResults
    return scoredResults.slice(0, nResults);
  }
  
  async generateAnswer(query, nResults = 5, filterMetadata = null, useLlm = true) {
    /**
     * Search for relevant documents and generate an answer using LLM
     * 
     * Args:
     *   query: User's question
     *   n_results: Number of RAG results to use as context
     *   filter_metadata: Optional metadata filters
     *   use_llm: Whether to use LLM to generate answer (default: true)
     * 
     * Returns:
     *   Dictionary with search results and generated answer
     */
    let searchResults;
    try {
      searchResults = await this.search(query, nResults, filterMetadata);
    } catch (e) {
      logger.error(`Error during search: ${e.message}`);
      return {
        query: query,
        results: [],
        results_count: 0,
        answer: null,
        context_used: 0,
        error: `Search error: ${e.message}`
      };
    }
    
    if (!searchResults || searchResults.length === 0) {
      return {
        query: query,
        results: [],
        results_count: 0,
        answer: null,
        context_used: 0,
        error: 'No relevant documents found'
      };
    }
    
    // Combine top results into context
    const contextParts = [];
    for (let i = 0; i < Math.min(searchResults.length, nResults); i++) {
      const result = searchResults[i];
      const docText = result.document || '';
      const filename = result.metadata?.filename || 'Unknown';
      contextParts.push(`[Source ${i + 1} from ${filename}]:\n${docText}\n`);
    }
    
    const context = contextParts.join("\n");
    
    // Generate answer using LLM if available
    let answer = null;
    if (useLlm && this.llmService.isAvailable()) {
      logger.info("Generating answer using LLM...");
      answer = await this.llmService.generateAnswer(query, context);
    } else if (useLlm) {
      logger.warn("LLM service not available, returning search results only");
    }
    
    return {
      query: query,
      results: searchResults,
      results_count: searchResults.length,
      answer: answer,
      context_used: contextParts.length,
      context: context // Include context for agent analysis
    };
  }
  
  async getCollectionInfo() {
    /**Get information about the vector database collection*/
    return await this.vectorStore.getCollectionInfo();
  }
  
  async checkContradictions(answer, context, query) {
    /**
     * Contradiction Agent - Checks for contradictions in the answer
     * 
     * Args:
     *   answer: The answer from Doc Agent
     *   context: The context used to generate the answer
     *   query: Original user query
     * 
     * Returns:
     *   Dictionary with contradiction analysis
     */
    if (!answer || !context) {
      return {
        has_contradictions: false,
        analysis: 'לא ניתן לבדוק סתירות ללא תשובה או הקשר',
        contradictions: []
      };
    }
    
    // Build prompt for contradiction detection
    const prompt = `אתה סוכן בדיקת סתירות. בדוק את התשובה הבאה מול ההקשר שסופק וזהה סתירות, אי-התאמות או מידע סותר.

השאלה המקורית: ${query}

ההקשר מהמסמכים:
${context}

התשובה שניתנה:
${answer}

בדוק את התשובה בקפידה:
1. האם יש סתירות בין התשובה לבין ההקשר?
2. האם התשובה מכילה מידע שלא מופיע בהקשר?
3. האם יש אי-התאמות או מידע סותר?

השב בעברית:
- אם יש סתירות: ציין אותן בפירוט
- אם אין סתירות: אמת שהתשובה תואמת להקשר

תשובה:`;
    
    try {
      const analysis = await this.llmService.generateAnswer(
        "בדוק סתירות",
        prompt,
        800
      );
      
      if (!analysis) {
        return {
          has_contradictions: null,
          analysis: 'שגיאה בבדיקת סתירות',
          contradictions: []
        };
      }
      
      // Simple heuristic: check if analysis mentions contradictions
      const hasContradictions = ['סתירה', 'סותר', 'אי-התאמה', 'לא תואם', 'שגוי', 'לא נכון'].some(
        word => analysis.toLowerCase().includes(word)
      );
      
      return {
        has_contradictions: hasContradictions,
        analysis: analysis,
        contradictions: [] // Could be enhanced to extract specific contradictions
      };
    } catch (e) {
      logger.error(`Error checking contradictions: ${e.message}`);
      return {
        has_contradictions: null,
        analysis: `שגיאה בבדיקת סתירות: ${e.message}`,
        contradictions: []
      };
    }
  }
  
  async checkRisks(answer, context, query) {
    /**
     * Risk Agent - Identifies risks in the answer
     * 
     * Args:
     *   answer: The answer from Doc Agent
     *   context: The context used to generate the answer
     *   query: Original user query
     * 
     * Returns:
     *   Dictionary with risk analysis
     */
    if (!answer || !context) {
      return {
        has_risks: false,
        analysis: 'לא ניתן לזהות סיכונים ללא תשובה או הקשר',
        risks: []
      };
    }
    
    // Build prompt for risk detection
    const prompt = `אתה סוכן זיהוי סיכונים. בדוק את התשובה הבאה וזהה סיכונים פוטנציאליים, בעיות, או אזהרות.

השאלה המקורית: ${query}

ההקשר מהמסמכים:
${context}

התשובה שניתנה:
${answer}

בדוק את התשובה בקפידה וזהה:
1. סיכונים משפטיים או פיננסיים
2. סיכונים תפעוליים או ביצועיים
3. אזהרות או תנאים חשובים
4. מידע חסר שעלול להוות סיכון
5. אי-בהירות שעלולה לגרום לבעיות

השב בעברית:
- אם יש סיכונים: ציין אותם בפירוט והסבר את החשיבות
- אם אין סיכונים משמעותיים: אמת שהתשובה בטוחה

תשובה:`;
    
    try {
      const analysis = await this.llmService.generateAnswer(
        "זהה סיכונים",
        prompt,
        800
      );
      
      if (!analysis) {
        return {
          has_risks: null,
          analysis: 'שגיאה בזיהוי סיכונים',
          risks: []
        };
      }
      
      // Simple heuristic: check if analysis mentions risks
      const hasRisks = ['סיכון', 'אזהרה', 'בעיה', 'חסר', 'לא ברור', 'תשומת לב', 'זהירות'].some(
        word => analysis.toLowerCase().includes(word)
      );
      
      return {
        has_risks: hasRisks,
        analysis: analysis,
        risks: [] // Could be enhanced to extract specific risks
      };
    } catch (e) {
      logger.error(`Error checking risks: ${e.message}`);
      return {
        has_risks: null,
        analysis: `שגיאה בזיהוי סיכונים: ${e.message}`,
        risks: []
      };
    }
  }
  
  async getAllFilenames() {
    /**Get list of all unique filenames in the collection*/
    return await this.vectorStore.getAllFilenames();
  }

  async getFilesWithMetadata() {
    /**Get list of files with chunk count and upload date*/
    return await this.vectorStore.getFilesWithMetadata();
  }

  async getFirstChunkForFile(filename) {
    /**Get first chunk for file preview*/
    return await this.vectorStore.getFirstChunkForFile(filename);
  }

  async deleteDocuments(ids) {
    /**Delete documents by IDs*/
    const result = await this.vectorStore.deleteDocuments(ids);
    return result.deleted_count > 0;
  }
  
  async resetDatabase() {
    /**Reset the entire vector database*/
    return await this.vectorStore.resetCollection();
  }
}

export default RAGService;
