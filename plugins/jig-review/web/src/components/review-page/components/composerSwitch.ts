type ActiveComposer = {
  addComment: () => void;
  discard: () => void;
  hasContent: () => boolean;
  id: string;
};

let activeComposer: ActiveComposer | undefined;

/**
 * Marks a newly opened line composer as the active transient composer.
 *
 * @param composer Composer callbacks used when another line is selected.
 * @returns Cleanup callback that unregisters this composer.
 */
export function registerActiveComposer(composer: ActiveComposer): () => void {
  activeComposer = composer;

  return () => {
    if (activeComposer?.id === composer.id) {
      activeComposer = undefined;
    }
  };
}

/**
 * Resolves the currently active transient composer before another line opens.
 *
 * @param nextComposerId Change key for the line the user wants to open.
 */
export function resolveActiveComposerBeforeSwitch(nextComposerId: string): void {
  if (activeComposer === undefined || activeComposer.id === nextComposerId) {
    return;
  }

  const composer = activeComposer;

  if (composer.hasContent()) {
    const shouldAddComment = window.confirm(
      "You have an unfinished comment. Add it as a draft before opening a new conversation? Press Cancel to discard it.",
    );

    if (shouldAddComment) {
      composer.addComment();
    } else {
      composer.discard();
    }
  } else {
    composer.discard();
  }

  activeComposer = undefined;
}
