// Hash router: "#/gallery?remix=a/b.png" -> {view:'gallery', params:{remix:'a/b.png'}}
import { useState, useEffect } from 'preact/hooks';

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [name, query = ''] = raw.split('?');
  const params = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { view: name || '', params };
}

/** navigate('generate', {remix: path}) */
export function navigate(view, params) {
  const q = params ? '?' + new URLSearchParams(params) : '';
  const next = `#/${view}${q}`;
  if (location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = next;
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
