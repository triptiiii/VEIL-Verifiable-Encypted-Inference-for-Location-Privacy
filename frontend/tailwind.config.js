/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        veil: {
          bg: '#05080f',
          card: '#0b1120',
          border: '#1a2840',
          accent: '#00c6ff',
          teal: '#00e5c0',
          purple: '#7c3aed',
          coral: '#f97316',
          green: '#22c55e',
          muted: '#4a6080',
          text: '#c8d8ef',
        }
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 8s linear infinite',
        'fadeIn': 'fadeIn 0.4s ease-out',
        'slideUp': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp: { from: { transform: 'translateY(12px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } },
      }
    }
  },
  plugins: []
}
