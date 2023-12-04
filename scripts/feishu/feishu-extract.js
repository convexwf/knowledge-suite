
(async () => {
  var r = window.PageMain && window.PageMain.blockManager && window.PageMain.blockManager.rootBlockModel;
  if (!r) return JSON.stringify({ok:false,error:"no PageMain"});
  function ops(a){return a&&a.length?a.map(function(o){return o.insert}).join("").replace(/\n/g,"").trim():"";}
  function cap(s){if(!s||!s.caption)return"";var c=s.caption;return(c.text&&c.text.initialAttributedTexts&&c.text.initialAttributedTexts.text&&c.text.initialAttributedTexts.text["0"])||c.plainText||"";}
  function cellTxt(c){var t="";if(c.zoneState){if(c.zoneState.content&&c.zoneState.content.ops)t=ops(c.zoneState.content.ops);if(!t&&c.zoneState.allText)t=c.zoneState.allText.replace(/\n/g,"").trim();}
   if(!t&&c.children&&c.children.length){var tmp=[];walk(c.children,tmp);for(var i=0;i<tmp.length;i++){var s=tmp[i];if(s.type==="list"){var items=s.items||[];for(var j=0;j<items.length;j++){if(t)t+=" ";t+=typeof items[j]==="string"?items[j]:items[j].text;}}else if(s.content){if(t)t+=" ";t+=s.content;}}}return t;}
  function cellImg(c){if(c.children&&c.children.length===1&&c.children[0].type==="image"){var img=c.children[0];var d=(img.snapshot&&img.snapshot.image)||{};return{type:"figure",assets:d.token?[{source_url:"https://internal-api.feishu.cn/open-apis/drive/v1/medias/"+d.token+"/download",alt:d.name||""}]:[]};}return null;}
  function walk(b,o){var a=[],lt=null;
   function fl(){if(a.length===0)return;o.push({type:"list",items:a.map(function(i){var e={text:i.text};if(i.checked!==undefined)e.checked=i.checked;if(i.nested&&i.nested.length)e.items=i.nested;return e;})});a=[];lt=null;}
   for(var bi=0;bi<b.length;bi++){var x=b[bi],bt=x.type,isL=bt==="bullet"||bt==="ordered"||bt==="todo";
    if(isL){if(lt!==null&&lt!==bt)fl();lt=bt;var txt=ops(x.zoneState&&x.zoneState.content&&x.zoneState.content.ops)||(x.zoneState&&x.zoneState.allText)||"";if(!txt)continue;var t=[];if(x.children&&x.children.length)walk(x.children,t);var nl=[];for(var ti=0;ti<t.length;ti++){var ss=t[ti];if(ss.type==="list"){var its=ss.items||[];for(var ii=0;ii<its.length;ii++)nl.push(typeof its[ii]==="string"?its[ii]:its[ii].text);}else if(ss.content)nl.push(ss.content);}
     a.push({text:txt,checked:bt==="todo"?!!x.snapshot.done:undefined,nested:nl});continue;}
    fl();
    var hm=/^heading([1-6])$/.exec(bt);if(hm){var c=ops(x.zoneState&&x.zoneState.content&&x.zoneState.content.ops);if(c)o.push({type:"heading",level:Number(hm[1]),content:c});continue;}
    if(bt==="text"||(bt.indexOf("heading")===0&&bt.length>8)){var c=ops(x.zoneState&&x.zoneState.content&&x.zoneState.content.ops);if(c)o.push({type:"paragraph",content:c});continue;}
    if(bt==="code"){var code=(x.zoneState&&x.zoneState.allText)||"";if(code)o.push({type:"code",content:code});continue;}
    if(bt==="quote_container"||bt==="callout"){var t=[];if(x.children&&x.children.length)walk(x.children,t);var c="";for(var ti=0;ti<t.length;ti++){if(t[ti].content){if(c)c+="\n\n";c+=t[ti].content;}}if(c)o.push({type:"blockquote",content:c});continue;}
    if(bt==="image"){var d=(x.snapshot&&x.snapshot.image)||{};var c=cap(x.snapshot);
      // Collect image block reference for download (step 2)
      if(!window.__fe_img)window.__fe_img=[];
      window.__fe_img.push({token:d.token||"",block:x});
      o.push({type:"figure",assets:d.token?[{source_url:"https://internal-api.feishu.cn/open-apis/drive/v1/medias/"+d.token+"/download",alt:d.name||"",caption:c}]:[]});continue;}
    if(bt==="table"){var cols=x.snapshot&&x.snapshot.columns_id;if(cols&&cols.length&&x.children&&x.children.length){var allImg=true,ci=[];for(var ci4=0;ci4<x.children.length;ci4++){var f=cellImg(x.children[ci4]);if(f){ci.push(f);}else{allImg=false;ci.push(null);}}
     if(allImg&&ci.length>0){for(var ci5=0;ci5<ci.length;ci5++){if(ci[ci5])o.push(ci[ci5]);}}
     else{var rows=[],row=[];for(var ci6=0;ci6<x.children.length;ci6++){row.push(cellTxt(x.children[ci6]));if(row.length===cols.length){rows.push(row);row=[];}}if(row.length>0)rows.push(row);if(rows.length>0)o.push({type:"table",rows:rows});}}continue;}
    if(bt==="grid"){if(x.children&&x.children.length){for(var gi=0;gi<x.children.length;gi++){walk(x.children[gi].children||[],o);}}continue;}
    if(bt==="synced_reference"||bt==="synced_source"){if(x.children&&x.children.length)walk(x.children,o);continue;}
    if(x.children&&x.children.length)walk(x.children,o);}
   fl();}
  var pg="";if(r.zoneState&&r.zoneState.content&&r.zoneState.content.ops)pg=ops(r.zoneState.content.ops);else if(r.zoneState&&r.zoneState.allText)pg=r.zoneState.allText.replace(/\n/g,"").trim();
  var s=[];if(pg)s.push({type:"heading",level:1,content:pg});
  window.__fe_img=[];
  walk(r.children||[],s);

  // Step 2: download images using live block.imageManager.fetch()
  var imageData={};
  var imgs=window.__fe_img||[];
  for(var ii=0;ii<imgs.length;ii++){
    var token=imgs[ii].token, block=imgs[ii].block;
    if(!token||imageData[token])continue;
    try{
      var data=await new Promise(function(resolve){
        if(!block.imageManager||!block.imageManager.fetch){resolve(null);return;}
        block.imageManager.fetch(
          {token:token, isHD:false, fuzzy:false},
          null,
          function(sources){
            if(!sources||!sources.src){resolve(null);return;}
            // Download from the accessible src URL
            var x=new XMLHttpRequest();
            x.open("GET",sources.src,true);
            x.responseType="blob";
            x.onload=function(){
              if(x.status!==200){resolve(null);return;}
              var r=new FileReader();
              r.onload=function(){
                var uri=String(r.result);
                var comma=uri.indexOf(",");
                var b64=comma>0?uri.slice(comma+1):uri;
                // FNV-1a hash → 16 lowercase hex chars (like knowledge-store)
                var h=0x811c9dc5,p=0x01000193;
                for(var i=0;i<b64.length;i++)h=((h^b64.charCodeAt(i))*p)>>>0;
                // Second pass with different offset for upper 8 chars
                var h2=0xcbf29ce4;
                for(var i=0;i<b64.length;i++)h2=((h2^b64.charCodeAt(i))*p)>>>0;
                var hash=(h>>>0).toString(16).padStart(8,"0")+(h2>>>0).toString(16).padStart(8,"0");
                resolve({hash:hash,data:b64});
              };
              r.readAsDataURL(x.response);
            };
            x.onerror=function(){resolve(null);};
            x.send();
          }
        );
      });
      if(data)imageData[token]=data;
    }catch(e){}
  }
  return JSON.stringify({ok:true,title:pg,sections:s,imageData:imageData});
})()
