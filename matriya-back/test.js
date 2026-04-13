import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
})

async function testConnection() {
  try {
    console.log('Testing connection...')
    const client = await pool.connect()
    console.log('✅ Connected successfully')
    
    const result = await client.query('SELECT NOW() as current_time')
    console.log('✅ Query result:', result.rows[0])
    
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `)
    console.log('✅ Tables in database:')
    tables.rows.forEach(row => console.log('  -', row.table_name))
    
    client.release()
    console.log('✅ Connection test passed')
    process.exit(0)
  } catch (error) {
    console.error('❌ Connection failed:', error.message)
    process.exit(1)
  }
}

testConnection()