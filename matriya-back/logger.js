/**
 * Logger utility
 */
import { createWriteStream } from 'fs';
import { join } from 'path';

class Logger {
  constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'INFO';
  }

  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${message}\n`;
  }

  _log(level, message) {
    const formatted = this._formatMessage(level, message);
    console.log(formatted.trim());
  }

  info(message) {
    this._log('INFO', message);
  }

  error(message) {
    this._log('ERROR', message);
  }

  warn(message) {
    this._log('WARN', message);
  }

  debug(message) {
    if (this.logLevel === 'DEBUG') {
      this._log('DEBUG', message);
    }
  }
}

const logger = new Logger();
export default logger;
