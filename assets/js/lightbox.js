// Лайтбокс галереи: клик по фото → на весь экран, листание стрелками/свайпом.
(function () {
  var links = Array.prototype.slice.call(
    document.querySelectorAll('.gallery .work-card[href]')
  ).filter(function (a) {
    return /\.(jpe?g|webp|png)$/i.test(a.getAttribute('href').split('?')[0]);
  });
  if (!links.length) return;

  var overlay = document.createElement('div');
  overlay.className = 'lb';
  overlay.hidden = true;
  overlay.innerHTML =
    '<button class="lb__close" type="button" aria-label="Закрыть">×</button>' +
    '<button class="lb__prev" type="button" aria-label="Назад">‹</button>' +
    '<img class="lb__img" alt="">' +
    '<button class="lb__next" type="button" aria-label="Вперёд">›</button>' +
    '<p class="lb__count"></p>';
  document.body.appendChild(overlay);
  var img = overlay.querySelector('.lb__img');
  var count = overlay.querySelector('.lb__count');
  var cur = 0;

  function show(i) {
    cur = (i + links.length) % links.length;
    img.src = links[cur].getAttribute('href');
    img.alt = links[cur].querySelector('img').getAttribute('alt') || '';
    count.textContent = (cur + 1) + ' / ' + links.length;
  }
  function open(i) {
    show(i);
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function close() {
    overlay.hidden = true;
    document.body.style.overflow = '';
    img.removeAttribute('src');
  }
  links.forEach(function (a, i) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      open(i);
    });
  });
  overlay.querySelector('.lb__close').addEventListener('click', close);
  overlay.querySelector('.lb__prev').addEventListener('click', function (e) { e.stopPropagation(); show(cur - 1); });
  overlay.querySelector('.lb__next').addEventListener('click', function (e) { e.stopPropagation(); show(cur + 1); });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function (e) {
    if (overlay.hidden) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') show(cur - 1);
    if (e.key === 'ArrowRight') show(cur + 1);
  });
  var startX = null;
  overlay.addEventListener('touchstart', function (e) {
    startX = e.changedTouches[0].clientX;
  }, { passive: true });
  overlay.addEventListener('touchend', function (e) {
    if (startX === null) return;
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) show(cur + (dx < 0 ? 1 : -1));
    startX = null;
  }, { passive: true });
})();
