
(function(){
  // ===== Loader LOCAL-ONLY (sem CDN) =====
  function loadScript(src){
    return new Promise(function(resolve, reject){
      var s=document.createElement('script'); s.src=src; s.async=false;
      s.onload=function(){resolve(src)}; s.onerror=function(){reject(new Error('Falha ao carregar '+src))};
      document.head.appendChild(s);
    });
  }
  function ensureLibs(){
    return Promise.resolve()
      .then(function(){ return loadScript('/vendor/jspdf.umd.min.js'); })
      .then(function(){ return loadScript('/vendor/jspdf.plugin.autotable.min.js'); })
      .then(function(){ return loadScript('/vendor/xlsx.full.min.js'); })
      .then(function(){ return loadScript('/vendor/jszip.min.js'); })
      .then(function(){ return loadScript('/vendor/FileSaver.min.js'); })
      .catch(function(err){
        alert('Não foi possível carregar as bibliotecas locais em /vendor.\n\nColoque os arquivos exigidos na pasta /vendor (veja README.txt).');
        throw err;
      });
  }
  window.ensureLibs = ensureLibs;

  // ===== Estado =====
  window.registros=[]; window.registrosFiltrados=[]; window.LOGO_DATAURL='';

  // ===== Utils =====
  function escapeHtml(s){ if(s==null) return ''; s=String(s); var out=''; for(var i=0;i<s.length;i++){ var code=s.charCodeAt(i); if(code===38) out+='&amp;'; else if(code===60) out+='&lt;'; else if(code===62) out+='&gt;'; else if(code===34) out+='&quot;'; else if(code===39) out+='&#39;'; else out+=s.charAt(i);} return out; }
  function parseTimestamp(v){ if(!v) return null; var d=new Date(v); if(!isNaN(d.getTime())) return d; var m=String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/); if(m){ return new Date(+m[3], +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0), +(m[6]||0)); } return null; }
  function formatTimestamp(ts){ var d=parseTimestamp(ts); if(!d) return String(ts||''); function p(n){return ('0'+n).slice(-2);} return p(d.getDate())+'/'+p(d.getMonth()+1)+'/'+d.getFullYear()+' '+p(d.getHours())+':'+p(d.getMinutes()); }
  function normalizarDataInput(v){ if(!v) return null; var p=v.split('-'); return new Date(Date.UTC(+p[0], +p[1]-1, +p[2], 0,0,0)); }
  function fimDoDia(d){ if(!d) return null; return new Date(d.getTime()+24*60*60*1000-1); }

  // ===== Logo =====
  function loadLogoAsDataURL(){ return new Promise(function(resolve){ var img=new Image(); img.crossOrigin='anonymous'; img.onload=function(){ try{ var c=document.createElement('canvas'); c.width=img.width; c.height=img.height; c.getContext('2d').drawImage(img,0,0); window.LOGO_DATAURL=c.toDataURL('image/png'); resolve(window.LOGO_DATAURL);}catch(e){ resolve(window.LOGO_DATAURL=''); } }; img.onerror=function(){ resolve(window.LOGO_DATAURL=''); }; img.src='logo lsg.png'; }); }

  // ===== Tema PDF (cores) do CSS =====
  function getPdfHeaderColor(){
    try{
      var root=getComputedStyle(document.documentElement);
      var rgb=(root.getPropertyValue('--pdf-head-rgb')||'33,150,243').trim().split(',').map(function(n){return parseInt(n,10)||0});
      if(rgb.length!==3) return [33,150,243];
      return rgb;
    }catch(e){ return [33,150,243]; }
  }

  // ===== Dropdown Semana =====
  function popularSemanas(){ var sel=document.getElementById('fSemanaTitulo'); if(!sel) return; fetch('/api/gas?action=registros')
    .then(function(r){return r.json();})
    .then(function(data){ if(!data || !data.ok) return; var all=Array.isArray(data.data)? data.data:[]; var set=Object.create(null); for(var i=0;i<all.length;i++){ var t=all[i]&&all[i].TituloVideo? String(all[i].TituloVideo).trim():''; if(t) set[t]=1; } var tit=Object.keys(set).sort(function(a,b){return a.localeCompare(b,'pt-BR',{sensitivity:'base'})}); var opts='<option value="">Todas</option>'; for(var j=0;j<tit.length;j++){ var t2=tit[j]; opts+='<option value="'+escapeHtml(t2)+'">'+escapeHtml(t2)+'</option>'; } sel.innerHTML=opts; })
    .catch(function(err){ console.warn('Falha ao popular semanas:',err); }); }

  // ===== Buscar / Render =====
  function buscar(){ var status=document.getElementById('status'); status.innerHTML=''; var fMat=document.getElementById('fMat').value.trim(); var fNome=document.getElementById('fNome').value.trim(); var fTitulo=document.getElementById('fSemanaTitulo').value.trim(); var fDataI=document.getElementById('fDataInicio').value; var fDataF=document.getElementById('fDataFinal').value; var qs=new URLSearchParams({action:'registros'}); if(fMat) qs.append('matricula',fMat); if(fNome) qs.append('nome',fNome);
    fetch('/api/gas?'+qs.toString()).then(function(res){return res.json();}).then(function(data){ if(!data||!data.ok) throw new Error('Falha na API'); window.registros=Array.isArray(data.data)? data.data:[]; var di=normalizarDataInput(fDataI); var df=fimDoDia(normalizarDataInput(fDataF)); var lista=window.registros.filter(function(r){ var ts=parseTimestamp(r.Timestamp); if(!ts) return false; if(di && ts < di) return false; if(df && ts > df) return false; if(fTitulo && (r.TituloVideo||'') !== fTitulo) return false; return true; }); var mapa=Object.create(null); for(var i=0;i<lista.length;i++){ var r=lista[i]; var chave=(r.Matricula||'')+'__'+(r.SemanaISO||'')+'__'+(r.TituloVideo||''); var atual=mapa[chave]; var novoTS=parseTimestamp(r.Timestamp); if(!atual) mapa[chave]=r; else{ var antigoTS=parseTimestamp(atual.Timestamp); if(novoTS && antigoTS && novoTS < antigoTS) mapa[chave]=r; } } window.registrosFiltrados=Object.keys(mapa).map(function(k){return mapa[k];}).sort(function(a,b){ return String(a.Nome||'').localeCompare(String(b.Nome||''),'pt-BR',{sensitivity:'base'}); }); renderTabela(window.registrosFiltrados); status.innerHTML='<div class="ok">Busca concluída: '+window.registrosFiltrados.length+' registro(s).</div>'; }).catch(function(){ status.innerHTML='<div class="error">Falha na consulta.</div>'; }); }

  function renderTabela(list){ var tbody=document.getElementById('tbody'); tbody.innerHTML=''; if(!list||!list.length){ tbody.innerHTML='<tr><td colspan="7" class="muted">Sem resultados</td></tr>'; return; } var rows=''; for(var i=0;i<list.length;i++){ var r=list[i]; var dataPart=formatTimestamp(r.Timestamp); var assinatura=r.AssinaturaPNG? '<img class="sig-img" src="'+r.AssinaturaPNG+'" alt="Assinatura" />':'-'; rows+='<tr>'+'<td>'+escapeHtml(r.Matricula||'')+'</td>'+'<td>'+escapeHtml(r.Nome||'')+'</td>'+'<td>'+escapeHtml(r.Setor||'')+'</td>'+'<td>'+escapeHtml(r.SemanaISO||'')+'</td>'+'<td>'+escapeHtml(r.TituloVideo||'')+'</td>'+'<td>'+escapeHtml(dataPart)+'</td>'+'<td>'+assinatura+'</td>'+'</tr>'; } tbody.innerHTML=rows; }

  // ===== XLS =====
  function gerarXLS(){ window.ensureLibs().then(function(){ var base=(window.registrosFiltrados && window.registrosFiltrados.length)? window.registrosFiltrados:window.registros; if(!base||!base.length){ alert('Faça uma busca primeiro.'); return;} var linhas=base.map(function(r){ return {'Matrícula':r.Matricula||'','Funcionário':r.Nome||'','Setor':r.Setor||'','Semana (ISO)':r.SemanaISO||'','Título do Vídeo':r.TituloVideo||'','Data de participação':formatTimestamp(r.Timestamp)}; }); var wb=XLSX.utils.book_new(); var ws=XLSX.utils.json_to_sheet(linhas); XLSX.utils.book_append_sheet(wb, ws, 'Relatório'); XLSX.writeFile(wb, 'DSS_GIG_Relatorio_'+ new Date().toISOString().slice(0,10) +'.xlsx'); }).catch(function(err){ alert('Falha ao carregar bibliotecas: '+err.message); }); }

  // ===== Treinamentos =====
  function fetchTreinamentos(){ return fetch('/api/gas?action=treinamentos').then(function(r){return r.json();}).then(function(d){ return (d && d.ok && Array.isArray(d.data))? d.data : []; }).catch(function(){ return []; }); }

  // ===== Cálculo robusto do startY da 1ª página =====
  function computeFirstPageStartY(doc, tituloSemana, assuntosCabecalho, marginLeft, marginRight){
    var pageWidth=doc.internal.pageSize.getWidth();
    var usableWidth=pageWidth - marginLeft - marginRight;
    var LOGO_W=120; var LINE=12;
    var ySemana=78;
    var semanaLines=doc.splitTextToSize('Semana: '+(tituloSemana||'-'), usableWidth - (LOGO_W + 12));
    var y = ySemana + LINE * Math.max(1, semanaLines.length) + LINE; // após "Semana"
    if(assuntosCabecalho && assuntosCabecalho.length){
      var assuntosLines=doc.splitTextToSize('Assuntos: '+assuntosCabecalho, usableWidth);
      y += LINE * Math.max(1, assuntosLines.length);
    }
    // linha de data/hora (impressa em drawHeaderFooter como y + LINE)
    y += LINE * 2; 
    // acolchoamento final antes da tabela
    y += 4;
    return y;
  }

  // ===== PDF =====
  function gerarPDF(){ window.ensureLibs().then(function(){ loadLogoAsDataURL().then(function(){ var baseSource=(window.registrosFiltrados && window.registrosFiltrados.length)? window.registrosFiltrados:window.registros; if(!baseSource||!baseSource.length){ alert('Nenhum dado para gerar PDF.'); return;} var base=baseSource.slice().sort(function(a,b){ return String(a.Nome||'').localeCompare(String(b.Nome||''),'pt-BR',{sensitivity:'base'}); }); fetchTreinamentos().then(function(tList){ var titulos=[], seen=Object.create(null); for(var i=0;i<base.length;i++){ var t=base[i].TituloVideo; if(t && !seen[t]){ seen[t]=1; titulos.push(t);} } var tituloSemana=titulos.length? titulos.join('; '): '-'; var semanasISO=[], sseen=Object.create(null); for(var k=0;k<base.length;k++){ var s=base[k].SemanaISO; if(s && !sseen[s]){ sseen[s]=1; semanasISO.push(s);} } var assuntosCabecalho=''; if(tList && tList.length){ var setISO=Object.create(null); for(var u=0;u<semanasISO.length;u++){ setISO[semanasISO[u]]=1;} var hit=null; for(var x=0;x<tList.length;x++){ var tt=tList[x]; if(setISO[String(tt['SemanaISO'])]){ hit=tt; break; } } if(!hit && titulos.length){ for(var y=0;y<tList.length;y++){ var tt2=tList[y]; if(String(tt2['Titulo']).trim()===titulos[0]){ hit=tt2; break; } } } if(hit && hit['Assuntos']) assuntosCabecalho=String(hit['Assuntos']); }

    var jsPDF=window.jspdf.jsPDF; var doc=new jsPDF({orientation:'portrait', unit:'pt', format:'a4'});
    var compact = !!document.getElementById('pdfCompact').checked;
    var marginLeft=48, marginRight=48, marginTop= compact? 130:150, marginBottom=compact? 76:88;
    var pageWidth=doc.internal.pageSize.getWidth(); var pageHeight=doc.internal.pageSize.getHeight(); var usableWidth=pageWidth - marginLeft - marginRight;
    var LOGO_W=120, LOGO_H=52; var LINE = compact? 10:12; var SIG_MIN_H= 180; // assinaturas maiores
    var pdfHeadColor = getPdfHeaderColor();

    function drawHeaderFooter(pageNumber,totalPages){
      try{ if(window.LOGO_DATAURL) doc.addImage(window.LOGO_DATAURL,'PNG', pageWidth - marginRight - LOGO_W, 28, LOGO_W, LOGO_H); }catch(e){}
      doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.text('Diálogo Semanal de Segurança', marginLeft, 48);
      doc.setFont('helvetica','bold'); doc.setFontSize(14);
      var semanaText='Semana: '+(tituloSemana||'-');
      var semanaLines=doc.splitTextToSize(semanaText, usableWidth - (LOGO_W + 12));
      var ySemana=78; doc.text(semanaLines, marginLeft, ySemana);
      var y=ySemana + LINE * Math.max(1, semanaLines.length) + LINE;
      if(assuntosCabecalho && assuntosCabecalho.length){
        doc.setFont('helvetica','normal'); doc.setFontSize(11);
        var assuntosLines=doc.splitTextToSize('Assuntos: '+assuntosCabecalho, usableWidth);
        doc.text(assuntosLines, marginLeft, y);
        y += LINE * Math.max(1, assuntosLines.length);
      }
      var dt=new Date();
      var linhaDH='Relatório gerado em '+('0'+dt.getDate()).slice(-2)+'/'+('0'+(dt.getMonth()+1)).slice(-2)+'/'+dt.getFullYear()+' às '+('0'+dt.getHours()).slice(-2)+':'+('0'+dt.getMinutes()).slice(-2);
      doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.text(linhaDH, marginLeft, y + LINE);

      doc.setFont('helvetica','normal'); doc.setFontSize(7);
      var FOOT_LH=12, FOOT_Y=pageHeight-22;
      doc.text('Caterair Serviços de Bordo e Hotelaria LTDA - Base GIG', marginLeft, FOOT_Y - (FOOT_LH * 2));
      doc.text('CNPJ 33.375.601/0001-38', marginLeft, FOOT_Y - (FOOT_LH * 1));
      doc.text('Rua P, S/N, Área de Apoio do Aeroporto Internacional do Rio de Janeiro - Ilha do Governador - RJ', marginLeft, FOOT_Y);
    }

    // Cálculo robusto do startY somente para a 1ª página
    var START_Y_FIRSTPAGE = computeFirstPageStartY(doc, tituloSemana, assuntosCabecalho, marginLeft, marginRight);

    var head=[[ 'Matrícula','Funcionário','Setor','Data de Participação','Assinatura' ]];
    var body=base.map(function(r){ return [ r.Matricula||'', r.Nome||'', r.Setor||'', formatTimestamp(r.Timestamp)||'', '' ]; });

    doc.autoTable({
      startY: START_Y_FIRSTPAGE,
      head: head,
      body: body,
      margin:{ left:marginLeft, right:marginRight, top:marginTop, bottom:marginBottom },
      tableWidth: usableWidth,
      styles:{ font:'helvetica', fontSize: compact?7:8, cellPadding:4, valign:'middle', overflow:'linebreak' },
      headStyles:{ fillColor: pdfHeadColor, textColor:255, halign:'center' },
      didParseCell:function(d){ if(d.section==='body' && d.column.index===4){ d.cell.height=Math.max(d.cell.height, SIG_MIN_H);} },
      didDrawCell:function(d){ if(d.section==='body' && d.column.index===4){ var i=d.row.index; var sig=base[i].AssinaturaPNG; if(sig){ var pad=1; var x=d.cell.x+pad, y=d.cell.y+pad; var w=d.cell.width-pad*2, h=d.cell.height-pad*2; try{ doc.addImage(sig,'PNG',x,y,w,h);}catch(e){} } } },
      didDrawPage:function(hk){ var pageNumber=(hk && hk.pageNumber)? hk.pageNumber : (doc.internal.getCurrentPageInfo && doc.internal.getCurrentPageInfo().pageNumber) || 1; var totalPages=doc.internal.getNumberOfPages(); drawHeaderFooter(pageNumber, totalPages); }
    });

    var total=doc.internal.getNumberOfPages();
    for(var pi=1; pi<=total; pi++){
      doc.setPage(pi); doc.setFont('helvetica','italic'); doc.setFontSize(8);
      var FOOT_Y=pageHeight-22; var label='Página '+pi+' de '+total; doc.text(label, pageWidth - marginRight, FOOT_Y + 2, { align:'right' });
    }

    doc.save('DSS_GIG_Relatorio.pdf');
  }); }); }).catch(function(err){ alert('Falha ao carregar bibliotecas: '+err.message); }); }

  // ===== ZIP OFFLINE (LOCAL-only) =====
  function gerarPacoteOffline(){ window.ensureLibs().then(function(){ var baseSource=(window.registrosFiltrados && window.registrosFiltrados.length)? window.registrosFiltrados:window.registros; if(!baseSource||!baseSource.length){ alert('Nenhum dado para empacotar. Faça uma busca primeiro.'); return;} var base=baseSource.slice().sort(function(a,b){ return String(a.Nome||'').localeCompare(String(b.Nome||''),'pt-BR',{sensitivity:'base'}); }); fetchTreinamentos().then(function(tList){ var titulos=[], seen=Object.create(null); for(var i=0;i<base.length;i++){ var t=base[i].TituloVideo; if(t && !seen[t]){ seen[t]=1; titulos.push(t);} } var tituloSemana=titulos.length? titulos.join('; '):'-'; var semanasISO=[], sseen=Object.create(null); for(var j=0;j<base.length;j++){ var s=base[j].SemanaISO; if(s && !sseen[s]){ sseen[s]=1; semanasISO.push(s);} } var assuntosCabecalho=''; if(tList && tList.length){ var setISO=Object.create(null); for(var k=0;k<semanasISO.length;k++){ setISO[semanasISO[k]]=1;} var hit=null; for(var u=0;u<tList.length;u++){ var t2=tList[u]; if(setISO[String(t2['SemanaISO'])]){ hit=t2; break; } } if(!hit && titulos.length){ for(var w=0;w<tList.length;w++){ var t3=tList[w]; if(String(t3['Titulo']).trim()===titulos[0]){ hit=t3; break; } } } if(hit && hit['Assuntos']) assuntosCabecalho=String(hit['Assuntos']); }

  var zip=new JSZip(); var folder=zip.folder('DSS_GIG_offline'); var payload={ base:base, tituloSemana:tituloSemana, assuntosCabecalho:assuntosCabecalho, compact: !!document.getElementById('pdfCompact').checked };
  folder.file('data.json', JSON.stringify(payload, null, 2), {compression:'DEFLATE'});
  if(window.LOGO_DATAURL){ var b64=window.LOGO_DATAURL.split(',')[1]||window.LOGO_DATAURL; var byteChars=atob(b64); var arr=new Uint8Array(byteChars.length); for(var k2=0;k2<byteChars.length;k2++){ arr[k2]=byteChars.charCodeAt(k2);} var blobLogo=new Blob([arr], {type:'image/png'}); folder.file('logo.png', blobLogo); }

  // Copia VENDOR local para dentro do ZIP offline
  function fetchText(url){ return fetch(url).then(function(r){ return r.text(); }); }
  Promise.all([
    fetchText('/vendor/jspdf.umd.min.js'),
    fetchText('/vendor/jspdf.plugin.autotable.min.js')
  ]).then(function(arrTxt){ var vendor=folder.folder('vendor'); vendor.file('jspdf.umd.min.js', arrTxt[0]); vendor.file('jspdf.plugin.autotable.min.js', arrTxt[1]);

    var offlineHTML = ''
      + '<!DOCTYPE html>\n'
      + '<html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>'
      + '<title>DSS GIG — Relatório Offline</title>'
      + '<style>body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;} .btn{padding:10px 14px;border-radius:8px;border:1px solid #ddd;cursor:pointer;} .muted{color:#6b7280}</style>'
      + '<script src="vendor/jspdf.umd.min.js"><\\/script>'
      + '<script src="vendor/jspdf.plugin.autotable.min.js"><\\/script>'
      + '</head>'
      + '<body>'
      + '<h1>Relatório Offline — DSS GIG</h1>'
      + '<p class="muted">Este pacote foi gerado a partir de um snapshot local. Você pode gerar o PDF abaixo, sem internet.</p>'
      + '<button id="btnGerar" class="btn">Gerar PDF</button>'
      + '<script>'
      + '(function(){'
        + 'function p(n){ return ("0"+n).slice(-2); }'
        + 'document.getElementById("btnGerar").onclick=function(){ fetch("data.json").then(function(res){ return res.json(); }).then(function(snap){ var base=Array.isArray(snap.base)? snap.base:[]; var tituloSemana=snap.tituloSemana||"-"; var assuntosCabecalho=snap.assuntosCabecalho||""; var compact=!!snap.compact; var jsPDF=window.jspdf.jsPDF; var doc=new jsPDF({orientation:"portrait", unit:"pt", format:"a4"}); var marginLeft=48, marginRight=48, marginTop= compact?130:150, marginBottom=compact?76:88; var pageWidth=doc.internal.pageSize.getWidth(), pageHeight=doc.internal.pageSize.getHeight(); var usableWidth=pageWidth - marginLeft - marginRight; var LOGO_W=120, LOGO_H=52; var LINE= compact?10:12; var SIG_MIN_H=180; function drawHeaderFooter(pageNumber,totalPages,LOGO){ try{ if(LOGO) doc.addImage(LOGO, "PNG", pageWidth - marginRight - LOGO_W, 28, LOGO_W, LOGO_H);}catch(e){} doc.setFont("helvetica","bold"); doc.setFontSize(18); doc.text("Diálogo Semanal de Segurança", marginLeft, 48); doc.setFont("helvetica","bold"); doc.setFontSize(14); var semanaText="Semana: "+(tituloSemana||"-"); var semanaLines=doc.splitTextToSize(semanaText, usableWidth - (LOGO_W + 12)); var ySemana=78; doc.text(semanaLines, marginLeft, ySemana); var y=ySemana + LINE * Math.max(1, semanaLines.length) + LINE; if(assuntosCabecalho && assuntosCabecalho.length){ doc.setFont("helvetica","normal"); doc.setFontSize(11); var as=doc.splitTextToSize("Assuntos: "+assuntosCabecalho, usableWidth); doc.text(as, marginLeft, y); y += LINE * Math.max(1, as.length); } var dt=new Date(); var linhaDH="Relatório gerado em "+p(dt.getDate())+"/"+p(dt.getMonth()+1)+"/"+dt.getFullYear()+" às "+p(dt.getHours())+":"+p(dt.getMinutes()); doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.text(linhaDH, marginLeft, y + LINE); doc.setFont("helvetica","normal"); doc.setFontSize(7); var FOOT_LH=12, FOOT_Y=pageHeight-22; doc.text("Caterair Serviços de Bordo e Hotelaria LTDA - Base GIG", marginLeft, FOOT_Y - (FOOT_LH * 2)); doc.text("CNPJ 33.375.601/0001-38", marginLeft, FOOT_Y - (FOOT_LH * 1)); doc.text("Rua P, S/N, Área de Apoio do Aeroporto Internacional do Rio de Janeiro - Ilha do Governador - RJ", marginLeft, FOOT_Y); } function computeStartY(){ var LOGO_W=120; var LINE= compact?10:12; var ySemana=78; var semanaLines=doc.splitTextToSize('Semana: '+(tituloSemana||'-'), usableWidth - (LOGO_W + 12)); var y = ySemana + LINE * Math.max(1, semanaLines.length) + LINE; if(assuntosCabecalho && assuntosCabecalho.length){ var assuntosLines=doc.splitTextToSize('Assuntos: '+assuntosCabecalho, usableWidth); y += LINE * Math.max(1, assuntosLines.length); } y += LINE * 2; y += 4; return y; } var START_Y_FIRSTPAGE=computeStartY(); function loadLogo(cb){ fetch("logo.png").then(function(r){ if(!r.ok) return cb(null); return r.blob(); }).then(function(b){ if(!b) return cb(null); var fr=new FileReader(); fr.onload=function(){ cb(fr.result); }; fr.readAsDataURL(b); }).catch(function(){ cb(null); }); } loadLogo(function(LOGO){ var head=[["Matrícula","Funcionário","Setor","Data de Participação","Assinatura"]]; var body=base.map(function(r){ return [ r.Matricula||"", r.Nome||"", r.Setor||"", (r.Timestamp||""), "" ]; }); doc.autoTable({ startY: START_Y_FIRSTPAGE, head: head, body: body, margin:{ left:marginLeft, right:marginRight, top:marginTop, bottom:marginBottom }, tableWidth: usableWidth, styles:{ font:"helvetica", fontSize: compact?7:8, cellPadding:4, valign:"middle", overflow:"linebreak" }, headStyles:{ fillColor:[24,90,188], textColor:255, halign:"center" }, didParseCell:function(d){ if(d.section==="body" && d.column.index===4){ d.cell.height=Math.max(d.cell.height, SIG_MIN_H);} }, didDrawCell:function(d){ if(d.section==="body" && d.column.index===4){ var i=d.row.index; var sig=base[i].AssinaturaPNG; if(sig){ var pad=1; var x=d.cell.x+pad, y=d.cell.y+pad; var w=d.cell.width-pad*2, h=d.cell.height-pad*2; try{ doc.addImage(sig, "PNG", x, y, w, h);}catch(e){} } } }, didDrawPage:function(hk){ var pageNumber=(hk && hk.pageNumber)? hk.pageNumber : (doc.internal.getCurrentPageInfo && doc.internal.getCurrentPageInfo().pageNumber) || 1; var totalPages=doc.internal.getNumberOfPages(); drawHeaderFooter(pageNumber,totalPages,LOGO); } }); var total=doc.internal.getNumberOfPages(); for(var pi=1; pi<=total; pi++){ doc.setPage(pi); doc.setFont("helvetica","italic"); doc.setFontSize(8); var FOOT_Y=pageHeight-22; var label="Página "+pi+" de "+total; doc.text(label, pageWidth - marginRight, FOOT_Y + 2, {align:"right"}); } doc.save("DSS_GIG_Relatorio_OFFLINE.pdf"); }); }); };' + '})();' + '<\\/script>' + '</body></html>';

    folder.file('gestor_offline.html', offlineHTML);
    var n=new Date(); function pz(x){ return ('0'+x).slice(-2);} var stamp=n.getFullYear()+''+pz(n.getMonth()+1)+''+pz(n.getDate())+'_'+pz(n.getHours())+''+pz(n.getMinutes());
    zip.generateAsync({type:'blob'}).then(function(blob){ saveAs(blob, 'DSS_GIG_offline_'+stamp+'.zip'); });
  });
}); }).catch(function(err){ alert('Falha ao carregar bibliotecas: '+err.message); }); }

  // ===== Eventos =====
  document.getElementById('btnBuscar').addEventListener('click', buscar);
  document.getElementById('btnXLS').addEventListener('click', gerarXLS);
  document.getElementById('btnPDF').addEventListener('click', gerarPDF);
  document.getElementById('btnZIP').addEventListener('click', gerarPacoteOffline);
  document.getElementById('btnAddFunc').addEventListener('click', function(){ alert('Ação de novo funcionário (placeholder)'); });
  var ids=['fMat','fNome','fDataInicio','fDataFinal','fSemanaTitulo']; for (var ii=0; ii<ids.length; ii++){ var el=document.getElementById(ids[ii]); if(el){ el.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); buscar(); } }); } }

  // Init
  popularSemanas();
})();
