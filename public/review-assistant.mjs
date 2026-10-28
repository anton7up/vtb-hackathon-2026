export function needsAssistantReview(operation) {
  return operation?.kind === 'transfer' && operation.status === 'pending' && operation.code === 'MODEL_REVIEW';
}

export function reviewGreeting(name) {
  return `Здравствуйте${name ? `, ${name}` : ''}! Для продолжения проверки перевода нам нужна дополнительная информация от вас. Система выявила признаки, которые могут указывать на перевод под влиянием мошенников. Это предварительное подозрение, а не обвинение получателя. Расскажите, кому и с какой целью вы переводите деньги. Кто предложил перевод и знакомы ли вам реквизиты?`;
}

export function reviewStatus(operation) {
  if (!operation) return { title: 'Операция недоступна', text: 'Данные операции изменились. Закройте окно и обновите историю.', canChat: false };
  if (operation.status === 'completed') return { title: 'Перевод выполнен', text: 'Операция уже завершена. Повторное списание через помощника невозможно.', canChat: false };
  if (operation.status === 'blocked') return { title: 'Перевод остановлен', text: 'Операция заблокирована. Деньги не списаны. Для дальнейших действий обратитесь в банк по проверенному каналу.', canChat: false };
  if (!needsAssistantReview(operation)) return { title: 'Статус операции изменился', text: 'Проверьте актуальное решение в истории операций.', canChat: false };
  if (operation.review?.status === 'approved') return { title: 'Проверка сотрудником завершена', text: 'Сотрудник разрешил продолжить. Деньги ещё не списаны: необходимо ваше отдельное подтверждение.', canChat: false };
  return { title: 'Банк приостановил перевод', text: 'Нам нужно больше информации. Пожалуйста, пообщайтесь с ИИ-помощником, чтобы уточнить обстоятельства операции. Деньги не списаны. Приостановлен только этот перевод, не весь счёт.', canChat: true };
}
