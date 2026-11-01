// Where the marker images come from. Streamed edition: the images of the console's own Live Map
// (public files of the console UI, or of the share gateway for a visitor). The sandbox edition
// replaces this file with one that reads them from the package (sandbox/iconsrc.js).
import { apiUrl } from './config.js';

export const iconSource = (file) => apiUrl(`/images/maps/${file}`);
