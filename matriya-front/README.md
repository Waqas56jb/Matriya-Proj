# MATRIYA Frontend - React

Modern React-based web interface for the MATRIYA RAG system.

## Features

- **React 18** - Modern React with hooks
- **Document Upload** - Drag & drop or click to upload
- **Semantic Search** - Search through uploaded documents
- **Collection Info** - View database statistics
- **Modern UI** - Clean, responsive design with Hebrew RTL support
- **Axios** - For API communication

## Installation

1. **Install dependencies**:
```bash
npm install
```

## Development

2. **Start the development server**:
```bash
npm start
```

The app will open at http://localhost:3000

## Production Build

3. **Build for production**:
```bash
npm run build
```

This creates an optimized production build in the `build` folder.

## Configuration

### Backend API URL

The frontend uses the `REACT_APP_API_BASE_URL` environment variable to connect to the backend.

**For local development:**
1. Create a `.env` file in the `front` directory
2. Add: `REACT_APP_API_BASE_URL=http://localhost:8000`
3. Restart the development server

**For production (Vercel):**
The environment variable is automatically set to `https://matriya-back.vercel.app` in `vercel.json`.

See `ENV_SETUP.md` for detailed instructions.

## Project Structure

```
front/
├── public/
│   └── index.html          # HTML template
├── src/
│   ├── components/
│   │   ├── UploadTab.js    # Upload component
│   │   ├── SearchTab.js    # Search component
│   │   └── InfoTab.js      # Info component
│   ├── App.js              # Main app component
│   ├── App.css             # App styles
│   ├── index.js            # Entry point
│   └── index.css           # Global styles
├── package.json
└── README.md
```

## Features in Detail

### Upload Tab
- Drag and drop files
- Click to browse
- Progress indicator
- Success/error messages
- Supports: PDF, DOCX, TXT, DOC, XLSX, XLS

### Search Tab
- Semantic search across all documents
- Configurable number of results
- Shows similarity scores
- Displays relevant text chunks
- Enter key support

### Info Tab
- Collection name
- Document count
- Database path
- Refresh button

## Browser Support

- Chrome/Edge (recommended)
- Firefox
- Safari
- Modern browsers with ES6 support
