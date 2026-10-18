window.addEventListener('DOMContentLoaded', () => {
  window.SwaggerUIBundle({
    url: '/api/schema/',
    dom_id: '#swagger-ui',
    deepLinking: true,
    validatorUrl: null,
    persistAuthorization: false,
    supportedSubmitMethods: ['get', 'head'],
    requestInterceptor: request => {
      // The same schema works in production and local development.
      const url = new URL(request.url, location.origin);
      if (url.origin === 'https://cpchub.net') request.url = location.origin + url.pathname + url.search;
      return request;
    }
  });
});
