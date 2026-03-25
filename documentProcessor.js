/**
 * Document processing module for extracting text from various file formats
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import logger from './logger.js';
import { decodeTextFileBuffer } from './lib/textEncoding.js';
import { formatExcelCellForRAG, excelCompositionRowSuffix } from './lib/excelPercentFormat.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

/** Remove null bytes (0x00) so PostgreSQL UTF-8 and vector store accept the text. */
function sanitizeForUtf8(s) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : String(s);
  return str.replace(/\0/g, '');
}

class DocumentProcessor {
  constructor() {
    this.supportedFormats = {
      '.pdf': this._processPdf.bind(this),
      '.docx': this._processDocx.bind(this),
      '.doc': this._processDocx.bind(this), // Treat .doc as .docx (may need conversion)
      '.txt': this._processTxt.bind(this),
      '.xlsx': this._processExcel.bind(this),
      '.xls': this._processExcel.bind(this),
    };
  }

  async processFile(filePath) {
    /**
     * Process a file and extract its content
     * 
     * Args:
     *   filePath: Path to the file
     * 
     * Returns:
     *   Dictionary with 'text', 'metadata', and 'success' fields
     */
    const filePathObj = path.resolve(filePath);
    
    if (!fs.existsSync(filePathObj)) {
      return {
        success: false,
        error: `File not found: ${filePath}`,
        text: '',
        metadata: {}
      };
    }

    const extension = path.extname(filePathObj).toLowerCase();

    if (!this.supportedFormats[extension]) {
      return {
        success: false,
        error: `Unsupported file format: ${extension}`,
        text: '',
        metadata: {}
      };
    }

    try {
      const processor = this.supportedFormats[extension];
      const text = await processor(filePathObj);
      
      const stats = fs.statSync(filePathObj);
      const metadata = {
        filename: sanitizeForUtf8(path.basename(filePathObj)),
        file_path: filePathObj,
        file_size: stats.size,
        file_type: extension,
      };
      
      return {
        success: true,
        text: text,
        metadata: metadata,
        error: null
      };
    } catch (e) {
      logger.error(`Error processing file ${filePath}: ${e.message}`);
      return {
        success: false,
        error: `Error processing file: ${e.message}`,
        text: '',
        metadata: {}
      };
    }
  }

  async _processPdf(filePath) {
    /**Extract text from PDF file*/
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text.trim();
  }

  async _processDocx(filePath) {
    /**Extract text from Word document*/
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value.trim();
  }

  async _processTxt(filePath) {
    /**Extract text from plain text file (UTF-8 / BOM / Windows-1255 Hebrew).*/
    const buf = fs.readFileSync(filePath);
    return decodeTextFileBuffer(buf);
  }

  async _processExcel(filePath) {
    /**Extract text from Excel file (all sheets). TSV-style rows + sheet headers for RAG and Ask Matriya readability.*/
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const readOpts = { type: 'buffer', cellDates: true };
    if (ext === '.xls') {
      readOpts.codepage = 1255;
    }
    const workbook = XLSX.read(buf, readOpts);
    const textParts = [];

    for (const sheetName of workbook.SheetNames || []) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const safeName = sanitizeForUtf8(sheetName);
      textParts.push(
        `[גיליון: ${safeName}] [אחוזים: מספרים בין 0 ל-1 (לא כולל) הם שברי רכיב — הוצגו כ×100, למשל 0.14528→14.53%. סכום שברים בשורת הרכב חייב ~100%; אחרת סימון שורתי.]\n`
      );

      let data;
      try {
        data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
      } catch (e) {
        logger.warn(`sheet_to_json failed (${safeName}): ${e.message}`);
        data = [];
      }
      for (const row of data) {
        const formatted = row.map((cell) => formatExcelCellForRAG(cell));
        const suffix = excelCompositionRowSuffix(row);
        const rowText = formatted.map((c) => sanitizeForUtf8(String(c ?? ''))).join('\t') + suffix;
        if (rowText.trim()) textParts.push(rowText);
      }
      textParts.push('\n');
    }

    return sanitizeForUtf8(textParts.join('\n').trim());
  }
}

export default DocumentProcessor;
