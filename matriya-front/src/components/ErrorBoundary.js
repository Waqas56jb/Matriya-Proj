import React from 'react';

/**
 * ErrorBoundary catches JavaScript errors anywhere in their child component tree,
 * logs those errors, and displays a fallback UI instead of the component tree that crashed.
 * 
 * Specifically useful for catching React DOM reconciliation errors (insertBefore/removeChild)
 * caused by browser extensions like Google Translate or Grammarly.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // You can also log the error to an error reporting service
    console.error('[ErrorBoundary caught an error]', error, errorInfo);
  }

  handleReset = () => {
    // Clear error state and redirect or reload to recover
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback UI
      return (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          background: '#f8d7da',
          color: '#721c24',
          borderRadius: '8px',
          margin: '20px',
          border: '1px solid #f5c6cb',
          fontFamily: 'sans-serif'
        }}>
          <h2>אופס! משהו השתבש בתצוגה.</h2>
          <p>
            נראה כי תוסף דפדפן (כמו Google Translate) ביצע שינוי בדף שגרם לקריסת המערכת.
          </p>
          <pre style={{ 
            textAlign: 'left', 
            background: '#fff', 
            padding: '10px', 
            fontSize: '12px',
            overflow: 'auto',
            maxHeight: '200px'
          }}>
            {this.state.error && this.state.error.toString()}
          </pre>
          <button 
            onClick={this.handleReset}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              cursor: 'pointer',
              background: '#721c24',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              marginTop: '10px'
            }}
          >
            רענן את הדף לתיקון
          </button>
        </div>
      );
    }

    return this.props.children; 
  }
}

export default ErrorBoundary;
