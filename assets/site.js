(function () {
  // Menú móvil
  var btn = document.getElementById('menuBtn'), panel = document.getElementById('panel');
  if (btn && panel) {
    var close = function () { panel.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Menú'; };
    btn.addEventListener('click', function () {
      var open = panel.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? 'Cerrar' : 'Menú';
    });
    panel.addEventListener('click', function (e) { if (e.target.tagName === 'A') close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  // Formulario de contacto: envío sin salir de la página (Formspree). Si falla, el envío normal sigue funcionando.
  var form = document.getElementById('contactForm'), msg = document.getElementById('formMsg'), send = document.getElementById('sendBtn');
  if (form && window.fetch) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.className = 'form-msg'; msg.textContent = '';
      send.disabled = true; send.textContent = 'Enviando…';
      fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status);
          form.reset();
          msg.className = 'form-msg ok';
          msg.textContent = 'Mensaje enviado. Te respondemos pronto.';
        })
        .catch(function () {
          msg.className = 'form-msg err';
          msg.textContent = 'No se pudo enviar. Escríbenos por WhatsApp o a hell@plusplan.app.';
        })
        .then(function () { send.disabled = false; send.textContent = 'Enviar mensaje'; });
    });
  }
})();
