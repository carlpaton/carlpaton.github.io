document.querySelectorAll('pre').forEach(function(pre){
  var b=document.createElement('button');b.className='copy';b.textContent='Copy';
  b.onclick=function(){var t=pre.querySelector('code').innerText;
    (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='Copied!';setTimeout(function(){b.textContent='Copy'},1500)}).catch(function(){b.textContent='Press Ctrl+C'});};
  pre.appendChild(b);
});
