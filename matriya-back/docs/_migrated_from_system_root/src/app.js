const express = require('express')
const app = express()

app.use(express.json())

const documentRoutes = require('./modules/documents/document.routes')

app.get('/health', (req, res) => {
    res.json({ status: 'ok' })
})

app.use('/api/documents', documentRoutes)

module.exports = app