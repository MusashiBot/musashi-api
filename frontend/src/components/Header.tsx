import React from 'react';

interface HeaderProps {
  isDark: boolean;
  onToggleDark: () => void;
  wsConnected?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ isDark, onToggleDark, wsConnected = false }) => {
  return (
    <header className="sticky top-0 z-50 bg-white dark:bg-black border-b border-gray-200 dark:border-gray-800 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Musashi" className="w-8 h-8 rounded-lg" />
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-50">
            Musashi
          </h1>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${
              wsConnected ? 'ws-connected' : 'ws-disconnected'
            }`}></div>
            <span className="text-xs text-gray-600 dark:text-gray-400">
              {wsConnected ? 'Live' : 'Offline'}
            </span>
          </div>

          <span className="text-sm text-gray-600 dark:text-gray-400">
            {new Date().toLocaleTimeString()}
          </span>
          
          <button
            onClick={onToggleDark}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            aria-label="Toggle dark mode"
          >
            {isDark ? (
              <svg className="w-5 h-5 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l-2.12-2.12a4 4 0 00 5.656 5.656l2.12-2.12a6 6 0 10-5.656-5.656z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-gray-600" fill="currentColor" viewBox="0 0 20 20">
                <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </header>
  );
};
