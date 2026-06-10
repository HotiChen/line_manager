/**
 * Interaction Enhancements
 * Adds ripple effects and other microinteractions
 */

class InteractionEnhancer {
    constructor() {
        this.init();
    }

    init() {
        this.addRippleEffects();
        this.enhanceHoverEffects();
    }

    /**
     * Add ripple effect to buttons
     */
    addRippleEffects() {
        const buttons = document.querySelectorAll('.btn, .btn-primary, .btn-secondary, .btn-success, .btn-danger, .btn-warning');

        buttons.forEach(button => {
            // Skip if already has ripple
            if (button.dataset.ripple === 'true') return;

            button.dataset.ripple = 'true';
            button.addEventListener('click', (e) => this.createRipple(e, button));
        });
    }

    createRipple(event, element) {
        const ripple = document.createElement('span');
        ripple.classList.add('ripple');

        const rect = element.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = event.clientX - rect.left - size / 2;
        const y = event.clientY - rect.top - size / 2;

        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = x + 'px';
        ripple.style.top = y + 'px';

        element.appendChild(ripple);

        // Remove ripple after animation
        setTimeout(() => {
            ripple.remove();
        }, 600);
    }

    /**
     * Enhance hover effects on cards
     */
    enhanceHoverEffects() {
        // Add hover lift to cards
        const cards = document.querySelectorAll('.card:not(.card-hover):not(.card-hover-lift)');
        cards.forEach(card => {
            card.classList.add('card-hover-lift');
        });

        // Keep existing card-hover behavior
    }

    /**
     * Add slide-up animation to newly added elements
     */
    static animateNewElement(element) {
        element.style.opacity = '0';
        element.style.transform = 'translateY(24px)';

        // Trigger animation on next frame
        requestAnimationFrame(() => {
            element.style.transition = 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
            element.style.opacity = '1';
            element.style.transform = 'translateY(0)';
        });
    }
}

// Initialize on DOM load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.interactionEnhancer = new InteractionEnhancer();
    });
} else {
    window.interactionEnhancer = new InteractionEnhancer();
}

// Re-initialize ripples when new content is loaded
document.addEventListener('contentLoaded', () => {
    if (window.interactionEnhancer) {
        window.interactionEnhancer.addRippleEffects();
    }
});

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = InteractionEnhancer;
}
