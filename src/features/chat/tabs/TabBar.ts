import type { TabBarItem, TabId } from './types';

/** Callbacks for TabBar interactions. */
export interface TabBarCallbacks {
  /** Called when a tab badge is clicked. */
  onTabClick: (tabId: TabId) => void;

  /** Called when a tab badge is right-clicked. */
  onTabContextMenu: (item: TabBarItem, event: MouseEvent) => void;
}

/**
 * TabBar renders minimal numbered badge navigation.
 */
export class TabBar {
  private containerEl: HTMLElement;
  private callbacks: TabBarCallbacks;
  private readonly wheelHandler = (event: WheelEvent): void => {
    if (this.containerEl.scrollWidth <= this.containerEl.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    this.containerEl.scrollLeft += event.deltaY;
  };

  constructor(containerEl: HTMLElement, callbacks: TabBarCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;
    this.build();
  }

  /** Builds the tab bar UI. */
  private build(): void {
    this.containerEl.addClass('claudian-tab-badges');
    this.containerEl.addEventListener('wheel', this.wheelHandler, { passive: false });
  }

  /**
   * Updates the tab bar with new tab data.
   * @param items Tab items to render.
   */
  update(items: TabBarItem[]): void {
    // Clear existing badges
    this.containerEl.empty();

    // Render badges
    for (const item of items) {
      this.renderBadge(item);
    }

    const activeBadge = this.containerEl.querySelector('.claudian-tab-badge-active');
    activeBadge?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Renders a single tab badge. */
  private renderBadge(item: TabBarItem): void {
    // Determine state class (priority: active > attention > streaming > idle)
    let stateClass = 'claudian-tab-badge-idle';
    if (item.isActive) {
      stateClass = 'claudian-tab-badge-active';
    } else if (item.needsAttention) {
      stateClass = 'claudian-tab-badge-attention';
    } else if (item.isStreaming) {
      stateClass = 'claudian-tab-badge-streaming';
    }

    const badgeEl = this.containerEl.createDiv({
      cls: `claudian-tab-badge ${stateClass}`,
      text: item.title,
    });

    // Tooltip with full title
    badgeEl.setAttribute('aria-label', item.title);
    badgeEl.setAttribute('title', item.title);

    // Click handler to switch tab
    badgeEl.addEventListener('click', () => {
      this.callbacks.onTabClick(item.id);
    });

    badgeEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onTabContextMenu(item, event);
    });
  }

  /** Destroys the tab bar. */
  destroy(): void {
    this.containerEl.removeEventListener('wheel', this.wheelHandler);
    this.containerEl.empty();
    this.containerEl.removeClass('claudian-tab-badges');
  }
}
