import fs from 'node:fs';
import path from 'node:path';
import nunjucks from 'nunjucks';
const env=new nunjucks.Environment();
for(const n of ['pluralize','filesizeformat','date','slice','basic_markdown','outbound_url','linebreaks','linebreaksbr','floatformat','yesno','get_item','default_if_none']) env.addFilter(n,x=>x);
let output='const window = {};\n';
const token=/"[^"]*"|'[^']*'|[^\s]+/g;
function expr(s){return s.replace(/\bTrue\b/g,'true').replace(/\bFalse\b/g,'false').replace(/\bNone\b/g,'none').replace(/forloop\./g,'loop.').replace(/\|([a-z_]+):("[^"]*"|'[^']*'|[\w.]+)/g,'|$1($2)');}
function convert(s){
 return s.replace(/\{%\s*load .*?%\}/g,'').replace(/\{%\s*htmx_script\s*%\}/g,'<script src="/static/vendor/htmx.min.js" defer></script>').replace(/\{%\s*csrf_token\s*%\}/g,'<input type="hidden" name="csrfmiddlewaretoken" value="{{ csrf_token }}">')
 .replace(/\{%\s*static\s+(.+?)\s*%\}/g,(_,x)=>`{{ static_url(${x}) }}`)
 .replace(/\{%\s*url\s+(.+?)\s+as\s+(\w+)\s*%\}/g,(_,x,v)=>`{% set ${v} = url(${x.match(token).join(', ')}) %}`)
 .replace(/\{%\s*url\s+(.+?)\s*%\}/g,(_,x)=>`{{ url(${x.match(token).map(t=>t.replace(/^\w+=/, '')).join(', ')}) }}`)
 .replace(/\{%\s*screenshot_src\s+(\S+)\s+as\s+(\S+)\s*%\}/g,'{% set $2 = $1.image_url %}')
 .replace(/\{%\s*include\s+('[^']+'|"[^"]+")\s+with\s+(.+?)\s*%\}/g,(_,f,a)=>'{% with %}'+a.replace(/\s+only$/,'').match(/\w+=(?:'[^']*'|"[^"]*"|\S+)/g).map(v=>`{% set ${v} %}`).join('')+`{% include ${f} %}{% endwith %}`)
 .replace(/\{%\s*with\s+(.+?)\s*%\}/g,(_,x)=>'{% with %}'+x.match(/\w+=(?:'[^']*'|"[^"]*"|\S+)/g).map(v=>`{% set ${v} %}`).join(''))
 .replace(/\{%\s*with\s*%\}/g,'{% if true %}').replace(/\{%\s*endwith\s*%\}/g,'{% endif %}')
 .replace(/\{%\s*empty\s*%\}/g,'{% else %}')
 .replace(/\{%\s*querystring\s+(.+?)\s*%\}/g,(_,x)=>`{{ querystring({${x.replace(/=/g,': ')}}) }}`)
 .replace(/\{%\s*provider_login_url\s+('[^']+'|\w+).*?%\}/g,(_,p)=>`{{ provider_login_url(${p}) }}`)
 .replace(/\{%\s*get_providers\s+as\s+\w+\s*%\}/g,'')
 .replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g,expr)
 .replaceAll('user == item.author','user.pk == item.author.pk')
 .replace(/\{% if (featured_items|hidden_creations|rows) %\}/g,'{% if $1.length %}')
 .replaceAll('in an isolated VM','in a private validation Worker');
}
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(entry.name.endsWith('.html')||entry.name.endsWith('.txt')){let s=convert(fs.readFileSync(p,'utf8'));try { output+=nunjucks.precompileString(s,{name:path.relative('templates',p),env}); }catch(e){throw new Error(p+': '+e.message);}}}}
walk('templates');
output+='\nexport default window.nunjucksPrecompiled;\n';fs.writeFileSync('src/templates.generated.js',output);
