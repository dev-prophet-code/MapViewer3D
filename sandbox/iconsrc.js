// Marker images of the sandbox edition: data addresses from the page (nothing can be fetched there).
import { core } from './embedded.js';

export const iconSource = (file) => core().icons[file] ?? '';
