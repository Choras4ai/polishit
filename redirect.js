'use strict';
// Fixed destination: query parameters can never turn this into an open redirect.
const destination = new URL('https://www.runshi.top/');
destination.search = window.location.search;
destination.hash = window.location.hash === '#experience' ? '#compare' : window.location.hash;
window.location.replace(destination.href);
