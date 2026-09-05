// The product tour re-run signal — a cross-cutting constant, so it lives in shared (the ProductTour widget receives it; a feature or the app sends it).
// It is shared from here rather than as a constant inside the widget, to avoid an upward FSD reference.
export const START_TOUR_EVENT = 'everdict:start-tour'

export function startProductTour(): void {
  window.dispatchEvent(new CustomEvent(START_TOUR_EVENT))
}
