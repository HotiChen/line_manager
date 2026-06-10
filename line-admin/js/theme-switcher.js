/**
 * Theme Switcher
 * Handles light/dark mode toggle with localStorage persistence
 */

class ThemeSwitcher {
    constructor() {
        this.theme = localStorage.getItem('theme') || this.detectPreferredTheme();
        this.init();
    }

    detectPreferredTheme() {
        // Check system preference
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }
        return 'light';
    }

    init() {
        // Apply stored theme
        this.applyTheme(this.theme);

        //Create toggle UI
        this.createToggle();

        // Listen for system theme changes
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                const newTheme = e.matches ? 'dark' : 'light';
                this.applyTheme(newTheme);
                this.updateToggleUI();
            });
        }
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        this.theme = theme;

        // Dispatch custom event for other components
        window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
    }

    toggle() {
        const newTheme = this.theme === 'light' ? 'dark' : 'light';
        this.applyTheme(newTheme);
        this.updateToggleUI();
    }

    createToggle() {
        // Check if toggle already exists
        if (document.querySelector('.theme-toggle')) {
            this.updateToggleUI();
            return;
        }

        const toggle = document.createElement('button');
        toggle.className = 'theme-toggle';
        toggle.setAttribute('aria-label', 'Toggle theme');
        toggle.setAttribute('title', 'Toggle light/dark mode');
        toggle.innerHTML = `
      <svg class="sun-icon" width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="3"/>
        <path d="M10 2v2m0 12v2M18 10h-2M4 10H2m14.364-5.364l-1.414 1.414M7.05 16.95l-1.414 1.414M16.95 16.95l-1.414-1.414M7.05 7.05L5.636 5.636"/>
      </svg>
      <svg class="moon-icon" width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
        <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/>
      </svg>
    `;

        toggle.addEventListener('click', () => this.toggle());

        // Try to add to header - adapt based on actual header structure
        const header = document.querySelector('.page-header, .header, .navbar');
        if (header) {
            // Create container for theme toggle if needed
            let headerActions = header.querySelector('.header-actions');
            if (!headerActions) {
                headerActions = document.createElement('div');
                headerActions.className = 'header-actions';
                header.appendChild(headerActions);
            }
            headerActions.appendChild(toggle);
        } else {
            // Fallback: add to top-right of viewport
            toggle.style.position = 'fixed';
            toggle.style.top = '20px';
            toggle.style.right = '20px';
            toggle.style.zIndex = '9999';
            document.body.appendChild(toggle);
        }

        this.updateToggleUI();
    }

    updateToggleUI() {
        const toggle = document.querySelector('.theme-toggle');
        if (toggle) {
            const isDark = this.theme === 'dark';
            const sunIcon = toggle.querySelector('.sun-icon');
            const moonIcon = toggle.querySelector('.moon-icon');

            if (sunIcon && moonIcon) {
                sunIcon.style.display = isDark ? 'none' : 'block';
                moonIcon.style.display = isDark ? 'block' : 'none';
            }
        }
    }

    getCurrentTheme() {
        return this.theme;
    }
}

// Initialize on DOM load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.themeSwitcher = new ThemeSwitcher();
    });
} else {
    window.themeSwitcher = new ThemeSwitcher();
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThemeSwitcher;
}
