document.getElementById('login').onsubmit=async event=>{
 event.preventDefault();
 const form=event.currentTarget;
 try{const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:form.elements.key.value})});
 if(!response.ok)throw Error(response.status===429?'Слишком много попыток. Подождите минуту.':'Ключ не подошёл.');
 location.replace('/');}catch(error){document.getElementById('error').textContent=error.message;}
};
