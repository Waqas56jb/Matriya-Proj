const express = require('express')
const router = express.Router()
const supabase = require('../../config/supabase')

router.post('/', async (req, res) => {
    const { file_name, source, file_type, version, content_hash } = req.body
    const { data, error } = await supabase
        .from('documents')
        .insert({ file_name, source, file_type, version, content_hash })
        .select()
    if (error) return res.status(400).json({ error })
    res.json({ success: true, data })
})

router.get('/', async (req, res) => {
    const { data, error } = await supabase
        .from('documents')
        .select('*')
    if (error) return res.status(400).json({ error })
    res.json({ success: true, data })
})

module.exports = router