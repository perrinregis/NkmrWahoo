window.themeManager = {
    setTheme: (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        try {
            localStorage.setItem('selected-theme', theme);
        } catch (e) {
            console.warn("localStorage is not accessible:", e);
        }
    },
    getTheme: () => {
        try {
            return localStorage.getItem('selected-theme') || 'light';
        } catch (e) {
            console.warn("localStorage is not accessible:", e);
            return 'light';
        }
    },
    initTheme: () => {
        let savedTheme = 'light';
        try {
            savedTheme = localStorage.getItem('selected-theme') || 'light';
        } catch (e) {
            console.warn("localStorage is not accessible:", e);
        }
        document.documentElement.setAttribute('data-theme', savedTheme);
        return savedTheme;
    }
};