// CloudFront Function (runtime cloudfront-js-2.0), viewer request on the default (site) behaviour only,
// so /data/* and /api/* never reach it. Serves clean URLs (/poll -> poll.html) and sends old *.html
// URLs to the clean ones with a 301, keeping the query string (the admin sign-in returns ?code=&state=).
// dev/server.js loads this same file so local practice behaves like production.
var PAGES = ['poll', 'board', 'privacy', 'admin'];

function queryString(qs) {
  var parts = [];
  for (var key in qs) {
    var v = qs[key];
    if (v.multiValue) {
      for (var i = 0; i < v.multiValue.length; i++) parts.push(key + '=' + v.multiValue[i].value);
    } else {
      parts.push(key + '=' + v.value);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function redirect(location) {
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    // no-store: if the site is ever rolled back, browsers must not remember the redirect.
    headers: { location: { value: location }, 'cache-control': { value: 'no-store' } },
  };
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var old = uri.match(/^\/(index|poll|board|privacy|admin)\.html$/);
  if (old) return redirect((old[1] === 'index' ? '/' : '/' + old[1]) + queryString(request.querystring));
  if (uri === '/') { request.uri = '/index.html'; return request; }
  var name = uri.charAt(uri.length - 1) === '/' ? uri.slice(1, -1) : uri.slice(1);
  if (PAGES.indexOf(name) >= 0) {
    if (uri !== '/' + name) return redirect('/' + name + queryString(request.querystring));
    request.uri = '/' + name + '.html';
  }
  return request;
}
