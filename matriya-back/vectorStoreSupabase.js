/**
 * Supabase vector store using pgvector extension
 */
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import axios from 'axios';
import logger from './logger.js';
import settings from './config.js';

const { Pool } = pg;

/** Remove null bytes (0x00) - PostgreSQL UTF-8 does not allow them. */
function sanitizeForUtf8(s) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : String(s);
  return str.replace(/\0/g, '');
}

class SupabaseVectorStore {
  /**
   * Initialize Supabase vector store
   * 
   * Args:
   *   db_url: PostgreSQL connection string
   *   collection_name: Name of the collection/table
   *   embedding_model_name: Name of the embedding model
   */
  constructor(dbUrl, collectionName, embeddingModelName) {
    this.dbUrl = dbUrl;
    this.collectionName = collectionName;
    this.embeddingModelName = embeddingModelName;

    // Initialize embedding model (only if available, skip on Vercel)
    this.embeddingModel = null;
    this.embeddingDim = 384; // Default for all-MiniLM-L6-v2

    // On Vercel, always use API (no local models)
    if (process.env.VERCEL) {
      logger.info("Using embedding API (on Vercel)");
      this.embeddingDim = 384;
      this._localModelReady = Promise.resolve(false);
    } else {
      // Load local model; ingestion will wait for this so we prefer local over HF API (which often returns 410 for free tier)
      this._localModelReady = this._loadLocalModel()
        .then(() => true)
        .catch(e => {
          logger.warn(`Failed to load local embedding model: ${e.message}, will use API`);
          return false;
        });
    }

    // Normalize DB URL for SSL: Supabase/pg often use certs that Node treats as self-signed; force no-verify so connection succeeds
    const normalizedDbUrl = (() => {
      if (typeof dbUrl !== 'string') return dbUrl;
      if (dbUrl.includes('sslmode=')) {
        return dbUrl.replace(/sslmode=[^&]+/, 'sslmode=no-verify');
      }
      const sep = dbUrl.includes('?') ? '&' : '?';
      return `${dbUrl}${sep}sslmode=no-verify`;
    })();

    // Create connection pool with timeout
    try {
      this.pool = new Pool({
        connectionString: normalizedDbUrl,
        max: process.env.VERCEL ? 1 : 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: process.env.VERCEL ? 5000 : 10000,
        ssl: {
          rejectUnauthorized: false
        }
      });
      logger.info("Connection pool created successfully");
    } catch (e) {
      logger.error(`Failed to create connection pool: ${e.message}`);
      throw e;
    }

    // Initialize collection (table) - non-blocking, will retry on first use if needed
    this._initCollection().catch(e => {
      logger.warn(`Collection initialization had issues (may be OK if tables exist): ${e.message}`);
    });
  }

  async _loadLocalModel() {
    /**Load local embedding model using @xenova/transformers (like Python's sentence-transformers)*/
    try {
      const { pipeline } = await import('@xenova/transformers');
      logger.info(`Loading embedding model: ${this.embeddingModelName}`);
      
      // Map model name to the correct format for transformers.js
      // sentence-transformers/all-MiniLM-L6-v2 -> Xenova/all-MiniLM-L6-v2
      let modelName = this.embeddingModelName;
      if (modelName.startsWith('sentence-transformers/')) {
        modelName = 'Xenova/' + modelName.replace('sentence-transformers/', '');
      } else if (!modelName.startsWith('Xenova/')) {
        modelName = `Xenova/${modelName}`;
      }
      
      this.embeddingModel = await pipeline('feature-extraction', modelName, {
        quantized: true,  // Use quantized models for faster loading
        device: 'cpu'     // Use CPU (like Python version)
      });
      
      // Get embedding dimension from model by testing with a sample text
      const testResult = await this.embeddingModel('test', { 
        pooling: 'mean', 
        normalize: true 
      });
      this.embeddingDim = testResult.data.length;
      
      logger.info(`Embedding model loaded successfully (dimension: ${this.embeddingDim})`);
    } catch (e) {
      logger.warn(`Could not load local embedding model: ${e.message}`);
      this.embeddingModel = null;
    }
  }

  async _generateEmbeddingsApi(texts) {
    /**Generate embeddings using API (Hugging Face or OpenAI)*/
    // Try OpenAI first if available (better quality)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        return await this._generateOpenAIEmbeddings(texts, openaiKey);
      } catch (e) {
        logger.warn(`OpenAI embeddings failed, falling back to HF: ${e.message}`);
      }
    }
    
    // Use Hugging Face Inference API
    const apiUrl = `https://api-inference.huggingface.co/models/${this.embeddingModelName}`;
    const headers = {
      "Content-Type": "application/json"
    };

    // Add token if available
    const hfToken = process.env.HF_API_TOKEN || settings.HF_API_TOKEN;
    if (hfToken) {
      headers["Authorization"] = `Bearer ${hfToken}`;
    }

    const embeddings = [];
    for (const text of texts) {
      try {
        const response = await axios.post(
          apiUrl,
          { 
            inputs: text,
            options: {
              wait_for_model: true
            }
          },
          { 
            headers, 
            timeout: 60000  // Increased timeout for model loading
          }
        );
        if (response.status === 200) {
          let embedding = response.data;
          // Handle different response formats
          if (Array.isArray(embedding)) {
            // If it's an array, use it directly
            embedding = embedding[0] || embedding;
          } else if (embedding && Array.isArray(embedding[0])) {
            // Nested array
            embedding = embedding[0];
          }
          embeddings.push(embedding);
        } else {
          // Fallback: use simple hash-based embedding (not ideal but works)
          logger.warn(`API embedding failed with status ${response.status}, using fallback for text: ${text.substring(0, 50)}...`);
          embeddings.push(this._fallbackEmbedding(text));
        }
      } catch (e) {
        if (e.response) {
          logger.error(`Error generating embedding via API: ${e.response.status} - ${e.response.statusText}`);
          if (e.response.status === 410) {
            logger.warn("Hugging Face free serverless API no longer hosts this model (410 Gone). Use local embeddings, OPENAI_API_KEY, or HF Inference Endpoints.");
          }
          if (e.response.status === 503) {
            logger.warn("Model is loading, using fallback embedding");
          }
        } else {
          logger.error(`Error generating embedding via API: ${e.message}`);
        }
        embeddings.push(this._fallbackEmbedding(text));
      }
    }

    return embeddings;
  }

  async _generateOpenAIEmbeddings(texts, apiKey) {
    /**Generate embeddings using OpenAI API*/
    const apiUrl = "https://api.openai.com/v1/embeddings";
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };

    // OpenAI allows batch processing
    const response = await axios.post(
      apiUrl,
      {
        input: texts,
        model: "text-embedding-ada-002"  // or text-embedding-3-small
      },
      { headers, timeout: 60000 }
    );

    if (response.status === 200 && response.data.data) {
      // OpenAI returns embeddings in a different format
      return response.data.data.map(item => item.embedding);
    }
    throw new Error("OpenAI API returned unexpected format");
  }

  _fallbackEmbedding(text) {
    /**Fallback embedding using hash (simple but consistent)*/
    const hashObj = crypto.createHash('sha256').update(text);
    const hashBytes = hashObj.digest();
    // Create 384-dimensional vector from hash
    const embedding = [];
    for (let i = 0; i < this.embeddingDim; i++) {
      const byteVal = hashBytes[i % hashBytes.length];
      // Normalize to [-1, 1] range
      embedding.push((byteVal / 255.0) * 2 - 1);
    }
    return embedding;
  }

  async _initCollection() {
    /**Initialize collection table with pgvector extension*/
    const client = await this.pool.connect();
    try {
      // Enable pgvector extension
      await client.query("CREATE EXTENSION IF NOT EXISTS vector;");

      // Create table if not exists (with dynamic embedding dimension)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.collectionName} (
          id TEXT PRIMARY KEY,
          embedding vector(${this.embeddingDim}),
          document TEXT NOT NULL,
          metadata JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Create vector index for similarity search (IMPORTANT for performance)
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${this.collectionName}_embedding_idx 
          ON ${this.collectionName} 
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100);
        `);
      } catch (idxError) {
        // Index creation might fail if table is empty, that's OK
        logger.warn(`Index creation warning (may be normal): ${idxError.message}`);
      }

      // Create index on metadata for faster filtering
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${this.collectionName}_metadata_idx 
          ON ${this.collectionName} 
          USING GIN (metadata);
        `);
      } catch (idxError) {
        logger.warn(`Metadata index creation warning: ${idxError.message}`);
      }

      // Create index on metadata->filename for file filtering
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${this.collectionName}_metadata_filename_idx 
          ON ${this.collectionName} 
          USING BTREE ((metadata->>'filename'));
        `);
      } catch (idxError) {
        logger.warn(`Filename index creation warning: ${idxError.message}`);
      }

      await client.query("COMMIT");
      logger.info(`Collection '${this.collectionName}' initialized`);
    } catch (e) {
      await client.query("ROLLBACK");
      logger.error(`Error initializing collection: ${e.message}`);
      // Don't raise - allow the service to continue, table might already exist
      logger.warn("Continuing despite initialization error - table may already exist");
    } finally {
      client.release();
    }
  }

  _generateId(text, metadata) {
    /**Generate unique ID for document*/
    const content = `${text}_${metadata.filename || ''}_${metadata.chunk_index || ''}`;
    return crypto.createHash('md5').update(content).digest('hex');
  }

  async addDocuments(texts, metadatas, ids = null) {
    /**
     * Add documents to vector store
     * 
     * Args:
     *   texts: List of text chunks
     *   metadatas: List of metadata dictionaries
     *   ids: Optional list of IDs (will be generated if not provided)
     * 
     * Returns:
     *   List of document IDs
     */
    if (!texts || texts.length === 0) {
      return [];
    }

    // Strip null bytes so PostgreSQL UTF-8 accepts document/metadata
    texts = texts.map(t => sanitizeForUtf8(t));

    // Generate embeddings (prefer local model; wait briefly for it to finish loading on first use)
    logger.info(`Generating embeddings for ${texts.length} chunks...`);
    if (!this.embeddingModel && this._localModelReady) {
      await Promise.race([
        this._localModelReady,
        new Promise(r => setTimeout(r, 25000))
      ]);
    }
    let embeddings;
    if (this.embeddingModel) {
      // Use local model if available (like Python's sentence-transformers)
      try {
        const results = await Promise.all(
          texts.map(text => this.embeddingModel(text, { pooling: 'mean', normalize: true }))
        );
        embeddings = results.map(result => Array.from(result.data));
        logger.info("Generated embeddings using local model");
      } catch (e) {
        logger.warn(`Local model failed, falling back to API: ${e.message}`);
        embeddings = await this._generateEmbeddingsApi(texts);
      }
    } else {
      // Use API for embeddings (on Vercel or if local model not available)
      embeddings = await this._generateEmbeddingsApi(texts);
    }

    // Ensure embeddings are arrays and have the correct dimension
    embeddings = embeddings.map((emb, idx) => {
      let embeddingArray;
      if (Array.isArray(emb)) {
        embeddingArray = emb;
      } else if (emb && emb.data) {
        embeddingArray = Array.isArray(emb.data) ? emb.data : Object.values(emb.data);
      } else if (emb && typeof emb === 'object') {
        embeddingArray = Object.values(emb);
      } else {
        logger.error(`Invalid embedding format at index ${idx}: ${typeof emb}`);
        throw new Error(`Invalid embedding format at index ${idx}`);
      }
      
      // Ensure correct dimension
      if (embeddingArray.length !== this.embeddingDim) {
        logger.warn(`Embedding dimension mismatch: expected ${this.embeddingDim}, got ${embeddingArray.length}. Truncating or padding.`);
        if (embeddingArray.length > this.embeddingDim) {
          embeddingArray = embeddingArray.slice(0, this.embeddingDim);
        } else {
          // Pad with zeros
          while (embeddingArray.length < this.embeddingDim) {
            embeddingArray.push(0);
          }
        }
      }
      
      return embeddingArray;
    });

    // Generate IDs if not provided
    if (!ids) {
      ids = texts.map((text, i) => this._generateId(text, metadatas[i]));
    }

    // Insert into database in batches (avoids hundreds of round-trips and apparent "stuck" on large files)
    const BATCH_SIZE = 50;
    const client = await this.pool.connect();
    try {
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE, texts.length);
        const batchNum = Math.floor(start / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(texts.length / BATCH_SIZE);
        logger.info(`Inserting batch ${batchNum}/${totalBatches} (chunks ${start + 1}-${end})...`);
        const placeholders = [];
        const params = [];
        let p = 1;
        for (let i = start; i < end; i++) {
          placeholders.push(`($${p}, $${p + 1}::vector, $${p + 2}, $${p + 3}::jsonb)`);
          const embeddingArray = Array.isArray(embeddings[i]) ? embeddings[i] : (embeddings[i].data || embeddings[i]);
          params.push(
            ids[i],
            `[${embeddingArray.join(',')}]`,
            sanitizeForUtf8(texts[i]),
            sanitizeForUtf8(JSON.stringify(metadatas[i], null, 0))
          );
          p += 4;
        }
        const query = `
          INSERT INTO ${this.collectionName} (id, embedding, document, metadata)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (id) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            document = EXCLUDED.document,
            metadata = EXCLUDED.metadata
        `;
        await client.query(query, params);
      }
      logger.info(`Added ${texts.length} documents to vector store`);
    } catch (e) {
      logger.error(`Error adding documents: ${e.message}`);
      throw e;
    } finally {
      client.release();
    }

    return ids;
  }

  async search(query, nResults = 5, filterMetadata = null) {
    /**
     * Search for similar documents using pgvector
     * 
     * Args:
     *   query: Search query
     *   n_results: Number of results to return
     *   filter_metadata: Optional metadata filters
     * 
     * Returns:
     *   List of search results
     */
    // Generate query embedding (prefer local model; wait for it so we avoid HF 410 / OpenAI 401 on first request)
    if (!this.embeddingModel && this._localModelReady) {
      await Promise.race([
        this._localModelReady,
        new Promise(r => setTimeout(r, 15000))
      ]);
    }
    let queryEmbedding;
    if (this.embeddingModel) {
      try {
        const result = await this.embeddingModel(query, { pooling: 'mean', normalize: true });
        queryEmbedding = Array.from(result.data);
      } catch (e) {
        logger.warn(`Local model failed for query, falling back to API: ${e.message}`);
        const embeddings = await this._generateEmbeddingsApi([query]);
        queryEmbedding = Array.isArray(embeddings[0]) ? embeddings[0] : (embeddings[0].data || embeddings[0]);
      }
    } else {
      const embeddings = await this._generateEmbeddingsApi([query]);
      queryEmbedding = Array.isArray(embeddings[0]) ? embeddings[0] : (embeddings[0].data || embeddings[0]);
    }

    // Build query
    const client = await this.pool.connect();
    try {
      // Build WHERE clause for metadata filtering
      let whereClause = "";
      const params = [];
      let paramIndex = 1;

      if (filterMetadata) {
        const conditions = [];
        for (const [key, value] of Object.entries(filterMetadata)) {
          if (key === 'filenames' && Array.isArray(value) && value.length > 0) {
            conditions.push(`metadata->>'filename' = ANY($${paramIndex}::text[])`);
            params.push(value);
            paramIndex++;
          } else if (key === 'filename' && typeof value === 'string' && value) {
            // Exact match, path suffix (LIKE '%value'), or match by basename so "Report.pdf" matches "folder/Report.pdf"
            const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
            const basename = path.basename(value);
            const escapedBasename = basename.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
            conditions.push(
              `(metadata->>'filename' = $${paramIndex} OR metadata->>'filename' LIKE $${paramIndex + 1} OR metadata->>'filename' = $${paramIndex + 2} OR metadata->>'filename' LIKE $${paramIndex + 3})`
            );
            params.push(value, '%' + escaped, basename, '%' + escapedBasename);
            paramIndex += 4;
          } else if (key !== 'filenames' && value != null) {
            conditions.push(`metadata->>'${key}' = $${paramIndex}`);
            params.push(value);
            paramIndex++;
          }
        }
        if (conditions.length) whereClause = "WHERE " + conditions.join(" AND ");
      }

      // Similarity search using cosine distance
      const embeddingStr = `[${queryEmbedding.join(',')}]`;
      params.push(embeddingStr);
      const embeddingParam = paramIndex;
      paramIndex++;
      params.push(embeddingStr);
      const embeddingParam2 = paramIndex;
      paramIndex++;
      params.push(nResults);

      const querySql = `
        SELECT 
          id,
          document,
          metadata,
          1 - (embedding <=> $${embeddingParam}::vector) as distance
        FROM ${this.collectionName}
        ${whereClause}
        ORDER BY embedding <=> $${embeddingParam2}::vector ASC,
                 (metadata->>'chunk_index')::int ASC NULLS LAST,
                 id ASC
        LIMIT $${paramIndex}
      `;

      logger.debug(`Query embedding length: ${queryEmbedding.length}`);

      // First, check if table has any rows
      const countResult = await client.query(`SELECT COUNT(*) FROM ${this.collectionName}`);
      const totalCount = parseInt(countResult.rows[0].count);
      logger.info(`Total documents in table: ${totalCount}`);

      if (totalCount === 0) {
        logger.warn("No documents in table, returning empty results");
        return [];
      }

      // When filtering by file, log how many rows match the filter (helps debug "0 results" when table has docs)
      if (whereClause) {
        try {
          const filterCountResult = await client.query(
            `SELECT COUNT(*) FROM ${this.collectionName} ${whereClause}`,
            params.slice(0, params.length - 3)
          );
          const filterCount = parseInt(filterCountResult.rows[0].count);
          logger.info(`Documents matching filename filter: ${filterCount}`);
          if (filterCount === 0) {
            logger.warn("No documents match the file filter – file may not be indexed or name may differ. Try 'all files' or check indexed filenames.");
          }
        } catch (countErr) {
          logger.debug(`Filter count check failed (non-fatal): ${countErr.message}`);
        }
      }

      // Execute the search query
      const result = await client.query(querySql, params);
      logger.info(`Query returned ${result.rows.length} results`);

      // Format results
      const formattedResults = [];
      for (const row of result.rows) {
        let metadata = row.metadata;
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            metadata = {};
          }
        } else if (!metadata || typeof metadata !== 'object') {
          metadata = {};
        }

        formattedResults.push({
          id: row.id,
          document: row.document,
          metadata: metadata,
          distance: row.distance ? parseFloat(row.distance) : null
        });
      }

      return formattedResults;
    } catch (e) {
      logger.error(`Error searching: ${e.message}`);
      throw e;
    } finally {
      client.release();
    }
  }

  async getAllFilenames() {
    /**Get list of all unique filenames in the collection*/
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT DISTINCT metadata->>'filename' as filename
        FROM ${this.collectionName}
        WHERE metadata->>'filename' IS NOT NULL
        ORDER BY filename
      `);
      return result.rows.map(row => row.filename).filter(f => f);
    } catch (e) {
      logger.error(`Error getting filenames: ${e.message}`);
      return [];
    } finally {
      client.release();
    }
  }

  async getFilesWithMetadata() {
    /**Get list of files with chunk count and earliest created_at per file*/
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT metadata->>'filename' as filename,
               COUNT(*)::int as chunks_count,
               MIN(created_at) as uploaded_at
        FROM ${this.collectionName}
        WHERE metadata->>'filename' IS NOT NULL
        GROUP BY metadata->>'filename'
        ORDER BY MIN(created_at) DESC, filename
      `);
      return result.rows.map(row => ({
        filename: row.filename,
        chunks_count: row.chunks_count || 0,
        uploaded_at: row.uploaded_at ? row.uploaded_at.toISOString() : null
      }));
    } catch (e) {
      logger.error(`Error getting files with metadata: ${e.message}`);
      return [];
    } finally {
      client.release();
    }
  }

  async getFirstChunkForFile(filename) {
    /**Get first chunk text and metadata for a file (for preview)*/
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT document, metadata FROM ${this.collectionName}
         WHERE metadata->>'filename' = $1
         LIMIT 1`,
        [filename]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return { text: row.document, metadata: row.metadata || {} };
    } catch (e) {
      logger.error(`Error getting first chunk: ${e.message}`);
      return null;
    } finally {
      client.release();
    }
  }

  async getFullTextForFile(filename) {
    /**Get all chunk texts for a file concatenated (for Ask Matriya context)*/
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT document, (metadata->>'chunk_index')::int AS chunk_index
         FROM ${this.collectionName}
         WHERE metadata->>'filename' = $1
         ORDER BY (metadata->>'chunk_index')::int ASC NULLS LAST,
                  created_at ASC NULLS LAST,
                  id ASC`,
        [filename]
      );
      if (result.rows.length === 0) return null;
      return result.rows.map(r => r.document).join('\n\n');
    } catch (e) {
      logger.error(`Error getting full text for file: ${e.message}`);
      return null;
    } finally {
      client.release();
    }
  }

  async getCollectionInfo() {
    /**Get information about the collection*/
    const client = await this.pool.connect();
    try {
      const result = await client.query(`SELECT COUNT(*) FROM ${this.collectionName}`);
      const count = parseInt(result.rows[0].count);

      return {
        collection_name: this.collectionName,
        document_count: count,
        db_path: 'Supabase PostgreSQL'
      };
    } catch (e) {
      logger.error(`Error getting collection info: ${e.message}`);
      return {
        collection_name: this.collectionName,
        document_count: 0,
        db_path: 'Supabase PostgreSQL'
      };
    } finally {
      client.release();
    }
  }

  async deleteDocuments(ids = null, filterMetadata = null) {
    /**
     * Delete documents by IDs or filter metadata
     * 
     * Args:
     *   ids: List of document IDs to delete
     *   filter_metadata: Metadata filter to delete matching documents
     * 
     * Returns:
     *   Dictionary with deletion results
     */
    const client = await this.pool.connect();
    try {
      let deletedCount = 0;
      if (ids && ids.length > 0) {
        // Delete by IDs
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const result = await client.query(
          `DELETE FROM ${this.collectionName} WHERE id IN (${placeholders})`,
          ids
        );
        deletedCount = result.rowCount;
      } else if (filterMetadata) {
        // Delete by metadata filter (filename: same rules as search — path, basename, LIKE)
        const conditions = [];
        const params = [];
        let paramIndex = 1;
        for (const [key, value] of Object.entries(filterMetadata)) {
          if (key === 'filenames' && Array.isArray(value) && value.length > 0) {
            conditions.push(`metadata->>'filename' = ANY($${paramIndex}::text[])`);
            params.push(value);
            paramIndex++;
          } else if (key === 'filename' && typeof value === 'string' && value) {
            // Strict logical path only. LIKE/basename matching deleted every file sharing the same basename
            // (e.g. folderA/report.pdf and folderB/report.pdf) when removing one document.
            conditions.push(`metadata->>'filename' = $${paramIndex}`);
            params.push(value);
            paramIndex++;
          } else if (key !== 'filenames' && value != null) {
            conditions.push(`metadata->>'${key}' = $${paramIndex}`);
            params.push(value);
            paramIndex++;
          }
        }
        if (!conditions.length) {
          return { deleted_count: 0, error: 'No valid filter conditions' };
        }
        const whereClause = "WHERE " + conditions.join(" AND ");

        const result = await client.query(
          `DELETE FROM ${this.collectionName} ${whereClause}`,
          params
        );
        deletedCount = result.rowCount;
      } else {
        return { deleted_count: 0, error: "Either ids or filter_metadata must be provided" };
      }

      logger.info(`Deleted ${deletedCount} documents`);
      return { deleted_count: deletedCount };
    } catch (e) {
      logger.error(`Error deleting documents: ${e.message}`);
      return { deleted_count: 0, error: e.message };
    } finally {
      client.release();
    }
  }

  async resetCollection() {
    /**Reset the collection (delete all documents)*/
    const client = await this.pool.connect();
    try {
      await client.query(`TRUNCATE TABLE ${this.collectionName}`);
      logger.info("Collection reset successfully");
      return true;
    } catch (e) {
      logger.error(`Error resetting collection: ${e.message}`);
      return false;
    } finally {
      client.release();
    }
  }
}

export default SupabaseVectorStore;
