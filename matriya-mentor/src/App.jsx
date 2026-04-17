import { useState, useRef, useEffect } from 'react';

const WELCOME = 'שלום! אני מטריה מנטור. שאל אותי כל שאלה על חומרים, מתכות או מחקר.';

export default function App() {
  const [messages, setMessages] = useState([{ role: 'assistant', text: WELCOME }]);
  const [input, setInput] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function send() {
    const text = input.trim();
    if (!text) return;
    setMessages(prev => [...prev, { role: 'user', text }]);
    setInput('');
    setTimeout(() => {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', text: 'קיבלתי את שאלתך. המערכת בפיתוח — בקרוב תגובה מלאה.' },
      ]);
    }, 800);
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.logo}>🧪</span>
        <span style={styles.title}>Matriya Mentor</span>
      </header>

      <div style={styles.messages}>
        {messages.map((m, i) => (
          <div key={i} style={{ ...styles.bubble, ...(m.role === 'user' ? styles.userBubble : styles.aiBubble) }}>
            {m.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={styles.inputRow}>
        <textarea
          style={styles.textarea}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="הקלד שאלה כאן..."
          rows={2}
          dir="rtl"
        />
        <button style={styles.sendBtn} onClick={send}>שלח</button>
      </div>
    </div>
  );
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100dvh',
    background: '#0f1117',
    color: '#e8eaf6',
    fontFamily: "'Segoe UI', Arial, sans-serif",
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '16px 20px',
    background: '#1a1d2e',
    borderBottom: '1px solid #2d3050',
  },
  logo: { fontSize: '22px' },
  title: { fontSize: '18px', fontWeight: 700, color: '#7c83f7' },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  bubble: {
    maxWidth: '78%',
    padding: '12px 16px',
    borderRadius: '16px',
    lineHeight: 1.5,
    fontSize: '15px',
    whiteSpace: 'pre-wrap',
    direction: 'rtl',
    textAlign: 'right',
  },
  aiBubble: {
    background: '#1e2235',
    color: '#c5cae9',
    alignSelf: 'flex-start',
    borderBottomLeftRadius: '4px',
  },
  userBubble: {
    background: '#3f4cca',
    color: '#fff',
    alignSelf: 'flex-end',
    borderBottomRightRadius: '4px',
  },
  inputRow: {
    display: 'flex',
    gap: '10px',
    padding: '12px 16px',
    background: '#1a1d2e',
    borderTop: '1px solid #2d3050',
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    background: '#0f1117',
    border: '1px solid #3f4cca',
    borderRadius: '12px',
    color: '#e8eaf6',
    padding: '10px 14px',
    fontSize: '15px',
    resize: 'none',
    outline: 'none',
    direction: 'rtl',
    fontFamily: 'inherit',
  },
  sendBtn: {
    background: '#3f4cca',
    color: '#fff',
    border: 'none',
    borderRadius: '12px',
    padding: '10px 20px',
    fontSize: '15px',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};
